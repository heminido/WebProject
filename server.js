const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Pool } = require("pg");
const limits = require("./limits");

const port = Number(process.env.PORT) || 3000;
const instance = process.env.INSTANCE_NAME || `api-${port}`;
const page = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const stylesheet = fs.readFileSync(path.join(__dirname, "public", "style.css"), "utf8");
const frontendScript = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
const scrypt = promisify(crypto.scrypt);
const sessionLifetime = 7 * 24 * 60 * 60;
const activeTaskLimit = limits.maxActiveTasks;
const maxUploadSize = limits.maxPptxBytes;
const maxPdfSize = limits.maxPdfBytes;
const workerSecret = process.env.WORKER_SHARED_SECRET || "";
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const passwordOptions = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "webproject",
  user: process.env.DB_USER || "webproject",
  password: process.env.DB_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 3000
});

pool.on("error", (error) => {
  console.error("Database connection error:", error.message);
});

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("Очікується JSON.");
  }

  let body = "";
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) {
      throw new Error("Завеликий запит.");
    }
    body += chunk;
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Некоректний JSON.");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Некоректні дані.");
  }

  return data;
}

async function readCredentials(request) {
  const data = await readJson(request);
  const nickname = typeof data.nickname === "string" ? data.nickname.trim() : "";
  const password = data.password;

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(nickname)) {
    throw new Error("Нікнейм: 3–24 латинські літери, цифри або _.");
  }

  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new Error("Пароль повинен містити від 8 до 128 символів.");
  }

  return { nickname, password };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64, passwordOptions);
  return `${salt}:${hash.toString("hex")}`;
}

async function passwordMatches(password, storedHash) {
  const [salt, expectedHex] = storedHash.split(":");
  if (!salt || !expectedHex) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scrypt(password, salt, expected.length, passwordOptions);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function getSessionHash(request) {
  const cookies = (request.headers.cookie || "").split(";");
  const sessionCookie = cookies.find((cookie) => cookie.trim().startsWith("session="));
  const token = sessionCookie?.trim().slice("session=".length);

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }

  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(response, token, maxAge) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
  );
}

async function startSession(request, response, user) {
  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");

  const previousSession = getSessionHash(request);
  if (previousSession) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [previousSession]);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [tokenHash, user.id]
  );

  setSessionCookie(response, token, sessionLifetime);
  sendJson(response, 200, { authenticated: true, nickname: user.nickname, instance });
}

async function currentUser(request) {
  const sessionHash = getSessionHash(request);
  if (!sessionHash) {
    return null;
  }

  const result = await pool.query(
    "SELECT users.id, users.nickname FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()",
    [sessionHash]
  );

  return result.rows[0] || null;
}

async function saveUploadedFile(request) {
  await fs.promises.mkdir(uploadDir, { recursive: true });

  const storageName = `${crypto.randomUUID()}.pptx`;
  const temporaryPath = path.join(uploadDir, `${storageName}.part`);
  const finalPath = path.join(uploadDir, storageName);
  const file = await fs.promises.open(temporaryPath, "wx");
  let size = 0;
  let signature = Buffer.alloc(0);
  let tooLarge = false;

  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxUploadSize) {
        tooLarge = true;
        continue;
      }
      if (signature.length < 4) {
        signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
      }
      let offset = 0;
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset);
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    await file.close();
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }

  await file.close();

  if (tooLarge || size === 0 || signature.toString("hex") !== "504b0304") {
    await fs.promises.rm(temporaryPath, { force: true });
    const error = new Error(tooLarge
      ? `Файл завеликий. Максимум ${limits.maxPptxMiB} МіБ.`
      : "Файл не схожий на PPTX (ZIP)."
    );
    error.statusCode = tooLarge ? 413 : 400;
    throw error;
  }

  await fs.promises.rename(temporaryPath, finalPath);
  return { storageName, finalPath, size };
}

function authorizedWorker(request) {
  if (workerSecret.length < 32) {
    return null;
  }

  const name = request.headers["x-worker-name"];
  const provided = request.headers.authorization || "";
  const expected = `Bearer ${workerSecret}`;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return null;
  }

  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }

  return name;
}

async function saveWorkerPdf(request) {
  await fs.promises.mkdir(uploadDir, { recursive: true });

  const fileName = `${crypto.randomUUID()}.pdf`;
  const temporaryPath = path.join(uploadDir, `${fileName}.part`);
  const finalPath = path.join(uploadDir, fileName);
  const file = await fs.promises.open(temporaryPath, "wx");
  let size = 0;
  let signature = Buffer.alloc(0);

  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxPdfSize) {
        const error = new Error(`PDF перевищує ліміт ${limits.maxPdfMiB} МіБ.`);
        error.statusCode = 413;
        throw error;
      }
      if (signature.length < 5) {
        signature = Buffer.concat([signature, chunk.subarray(0, 5 - signature.length)]);
      }

      let offset = 0;
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset);
        offset += result.bytesWritten;
      }
    }

    if (size < 8 || signature.toString() !== "%PDF-") {
      const error = new Error("Результат не є PDF.");
      error.statusCode = 400;
      throw error;
    }
  } catch (error) {
    await file.close();
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }

  await file.close();
  try {
    await fs.promises.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
  return { fileName, finalPath };
}

async function handleWorkerFile(request, response) {
  const match = request.url?.match(/^\/api\/worker\/tasks\/(\d{1,19})\/(input|output)$/);
  if (!match) {
    return false;
  }

  const name = authorizedWorker(request);
  if (!name) {
    sendJson(response, 401, { error: "Доступ заборонено." });
    return true;
  }

  const taskId = match[1];
  const action = match[2];
  if ((action === "input" && request.method !== "GET") ||
      (action === "output" && request.method !== "POST")) {
    sendJson(response, 405, { error: "Метод не підтримується." });
    return true;
  }

  const result = await pool.query(
    `SELECT storage_name FROM tasks
     WHERE id = $1 AND status = 'processing' AND worker_name = $2`,
    [taskId, name]
  );
  if (result.rowCount === 0) {
    sendJson(response, 409, { error: "Задача не обробляється цим worker." });
    return true;
  }

  if (action === "input") {
    const storedName = result.rows[0].storage_name;
    if (!storedName || !/^[0-9a-f-]{36}\.pptx$/.test(storedName)) {
      sendJson(response, 404, { error: "PPTX не знайдено." });
      return true;
    }

    const sourcePath = path.join(uploadDir, storedName);
    const info = await fs.promises.stat(sourcePath).catch(() => null);
    if (!info || !info.isFile() || info.size > maxUploadSize) {
      sendJson(response, 404, { error: "PPTX відсутній у сховищі." });
      return true;
    }

    const stream = fs.createReadStream(sourcePath);
    stream.on("error", () => response.destroy());
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store"
    });
    stream.pipe(response);
    return true;
  }

  if (request.headers["content-type"] !== "application/pdf") {
    sendJson(response, 415, { error: "Очікується PDF." });
    return true;
  }

  let saved;
  let attached = false;
  try {
    saved = await saveWorkerPdf(request);
    const updated = await pool.query(
      `UPDATE tasks SET status = 'completed', progress = 100,
         output_name = $1, finished_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'processing' AND worker_name = $3
       RETURNING id`,
      [saved.fileName, taskId, name]
    );
    if (updated.rowCount === 0) {
      sendJson(response, 409, { error: "Задачу вже змінено." });
      return true;
    }

    attached = true;
    sendJson(response, 200, { completed: true });
  } catch (error) {
    if (error.statusCode) {
      sendJson(response, error.statusCode, { error: error.message });
    } else {
      throw error;
    }
  } finally {
    if (saved && !attached) {
      await fs.promises.rm(saved.finalPath, { force: true });
    }
  }
  return true;
}

async function createTask(user, filename, response) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [user.id]);

    const result = await client.query(
      "SELECT COUNT(*)::INTEGER AS total FROM tasks WHERE user_id = $1 AND status IN ('draft', 'queued', 'processing')",
      [user.id]
    );

    if (result.rows[0].total >= activeTaskLimit) {
      await client.query("ROLLBACK");
      sendJson(response, 409, { error: `Ліміт: не більше ${activeTaskLimit} активних задач.` });
      return;
    }

    const inserted = await client.query(
      "INSERT INTO tasks (user_id, source_filename) VALUES ($1, $2) RETURNING id, source_filename, conversion_type, status, progress, created_at",
      [user.id, filename]
    );

    await client.query("COMMIT");
    sendJson(response, 201, { task: inserted.rows[0], instance });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw error;
  } finally {
    client.release();
  }
}

async function queueUploadedFile(user, filename, saved) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [user.id]);
    const count = await client.query(
      "SELECT COUNT(*)::INTEGER AS total FROM tasks WHERE user_id = $1 AND status IN ('draft', 'queued', 'processing')",
      [user.id]
    );
    if (count.rows[0].total >= activeTaskLimit) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query(
      `INSERT INTO tasks (user_id, source_filename, status, storage_name, file_size_bytes)
       VALUES ($1, $2, 'queued', $3, $4) RETURNING id`,
      [user.id, filename, saved.storageName, saved.size]
    );
    await client.query("COMMIT");
    return result.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deleteHistory(userId, taskId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const parameters = taskId ? [userId, taskId] : [userId];
    const rows = await client.query(
      `SELECT id, storage_name, output_name FROM tasks
       WHERE user_id = $1 AND status IN ('draft', 'completed', 'failed', 'cancelled')
       ${taskId ? "AND id = $2" : ""}
       ORDER BY id FOR UPDATE`,
      parameters
    );
    for (const task of rows.rows) {
      if (task.storage_name) {
        if (!/^[0-9a-f-]{36}\.pptx$/.test(task.storage_name)) {
          throw new Error("Invalid PPTX storage name");
        }
        await fs.promises.rm(path.join(uploadDir, task.storage_name), { force: true });
      }
      if (task.output_name) {
        if (!/^[0-9a-f-]{36}\.pdf$/.test(task.output_name)) {
          throw new Error("Invalid PDF storage name");
        }
        await fs.promises.rm(path.join(uploadDir, task.output_name), { force: true });
      }
    }
    if (rows.rowCount > 0) {
      await client.query(
        "DELETE FROM tasks WHERE user_id = $1 AND id = ANY($2::bigint[])",
        [userId, rows.rows.map((task) => task.id)]
      );
    }
    await client.query("COMMIT");
    return rows.rowCount;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleRequest(request, response) {
  if (await handleWorkerFile(request, response)) {
    return;
  }

  if (request.method === "GET" && request.url === "/api/config") {
    sendJson(response, 200, {
      maxPptxMiB: limits.maxPptxMiB,
      maxActiveTasks: limits.maxActiveTasks,
      conversionTimeoutSeconds: limits.conversionTimeoutSeconds
    });
    return;
  }

  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { status: "ok", instance, port });
    return;
  }

  if (request.method === "GET" && request.url === "/api/database") {
    try {
      const result = await pool.query("SELECT current_database() AS name");
      sendJson(response, 200, { status: "connected", instance, database: result.rows[0].name });
    } catch (error) {
      console.error("Database check failed:", error.message);
      sendJson(response, 503, { status: "unavailable", instance });
    }
    return;
  }

  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  if (request.method === "GET" && request.url === "/style.css") {
    response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(stylesheet);
    return;
  }

  if (request.method === "GET" && request.url === "/app.js") {
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    response.end(frontendScript);
    return;
  }

  if (request.method === "GET" && request.url === "/api/me") {
    const user = await currentUser(request);
    sendJson(response, 200, user
      ? { authenticated: true, nickname: user.nickname, instance }
      : { authenticated: false, instance });
    return;
  }

  if (request.method === "POST" && request.url === "/api/tasks/convert") {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }
    if (request.headers["content-type"] !== "application/octet-stream") {
      sendJson(response, 415, { error: "Очікується вміст PPTX-файлу." });
      return;
    }

    let filename;
    try {
      const encoded = request.headers["x-file-name"];
      filename = typeof encoded === "string" ? decodeURIComponent(encoded) : "";
      if (filename.length < 6 || filename.length > 120 || !/\.pptx$/i.test(filename) || /[\x00-\x1f/\\]/.test(filename)) {
        throw new Error("Виберіть PPTX-файл з назвою до 120 символів.");
      }
    } catch {
      sendJson(response, 400, { error: "Некоректна назва PPTX-файлу." });
      return;
    }

    let saved;
    let attached = false;
    let reply;
    try {
      saved = await saveUploadedFile(request);
      const taskId = await queueUploadedFile(user, filename, saved);
      if (taskId) {
        attached = true;
        reply = { status: 201, data: { queued: true, taskId, instance } };
      } else {
        reply = { status: 409, data: { error: `Ліміт: не більше ${activeTaskLimit} активних задач.` } };
      }
    } catch (error) {
      if (error.statusCode) {
        reply = { status: error.statusCode, data: { error: error.message } };
      } else {
        throw error;
      }
    } finally {
      if (saved && !attached) {
        await fs.promises.rm(saved.finalPath, { force: true });
      }
    }
    sendJson(response, reply.status, reply.data);
    return;
  }

  if (request.method === "DELETE" && request.url === "/api/tasks/history") {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }
    const deleted = await deleteHistory(user.id);
    sendJson(response, 200, { deleted, instance });
    return;
  }

  const deleteMatch = request.url?.match(/^\/api\/tasks\/(\d{1,19})$/);
  if (request.method === "DELETE" && deleteMatch) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }
    const deleted = await deleteHistory(user.id, deleteMatch[1]);
    if (!deleted) {
      sendJson(response, 409, { error: "Задачу не знайдено або вона ще виконується." });
      return;
    }
    sendJson(response, 200, { deleted, instance });
    return;
  }

  if (request.url === "/api/tasks" && (request.method === "GET" || request.method === "POST")) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }

    if (request.method === "GET") {
      const result = await pool.query(
        "SELECT id, source_filename, conversion_type, status, progress, processing_stage, created_at, (storage_name IS NOT NULL) AS has_file, file_size_bytes, (output_name IS NOT NULL) AS has_output, worker_name, error_message FROM tasks WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30",
        [user.id]
      );
      sendJson(response, 200, { tasks: result.rows, instance });
      return;
    }

    let filename;
    try {
      const data = await readJson(request);
      filename = typeof data.filename === "string" ? data.filename.trim() : "";
      if (filename.length < 6 || filename.length > 120 || !/\.pptx$/i.test(filename) || /[\x00-\x1f/\\]/.test(filename)) {
        throw new Error("Вкажіть назву файлу .pptx (до 120 символів, без шляху)." );
      }
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }

    await createTask(user, filename, response);
    return;
  }

  const startMatch = request.url?.match(/^\/api\/tasks\/(\d{1,19})\/start$/);
  if (request.method === "POST" && startMatch) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }

    const result = await pool.query(
      `UPDATE tasks SET status = 'queued', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'draft' AND storage_name IS NOT NULL
       RETURNING id`,
      [startMatch[1], user.id]
    );

    if (result.rowCount === 0) {
      sendJson(response, 409, { error: "Додайте PPTX до чернетки перед запуском." });
      return;
    }

    sendJson(response, 200, { queued: true, instance });
    return;
  }

  const downloadMatch = request.url?.match(/^\/api\/tasks\/(\d{1,19})\/download$/);
  if (request.method === "GET" && downloadMatch) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }

    const result = await pool.query(
      "SELECT output_name FROM tasks WHERE id = $1 AND user_id = $2 AND status = 'completed'",
      [downloadMatch[1], user.id]
    );
    const outputName = result.rows[0]?.output_name;
    if (!outputName || !/^[0-9a-f-]{36}\.pdf$/.test(outputName)) {
      sendJson(response, 404, { error: "Готовий PDF не знайдено." });
      return;
    }

    const outputPath = path.join(uploadDir, outputName);
    const info = await fs.promises.stat(outputPath).catch(() => null);
    if (!info || !info.isFile()) {
      sendJson(response, 404, { error: "PDF відсутній у сховищі." });
      return;
    }

    const stream = fs.createReadStream(outputPath);
    stream.on("error", () => response.destroy());
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="task-${downloadMatch[1]}.pdf"`,
      "Content-Length": info.size,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    stream.pipe(response);
    return;
  }

  const uploadMatch = request.url?.match(/^\/api\/tasks\/(\d{1,19})\/upload$/);
  if (request.method === "POST" && uploadMatch) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }

    if (request.headers["content-type"] !== "application/octet-stream") {
      sendJson(response, 415, { error: "Очікується вміст файлу." });
      return;
    }

    const taskId = uploadMatch[1];
    const existing = await pool.query(
      "SELECT id FROM tasks WHERE id = $1 AND user_id = $2 AND status = 'draft' AND storage_name IS NULL",
      [taskId, user.id]
    );
    if (existing.rowCount === 0) {
      sendJson(response, 409, { error: "Чернетка не знайдена або файл уже завантажено." });
      return;
    }

    let saved;
    let attached = false;
    try {
      saved = await saveUploadedFile(request);
      const updated = await pool.query(
        "UPDATE tasks SET storage_name = $1, file_size_bytes = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 AND status = 'draft' AND storage_name IS NULL RETURNING id",
        [saved.storageName, saved.size, taskId, user.id]
      );
      if (updated.rowCount === 0) {
        sendJson(response, 409, { error: "Чернетку вже змінено. Файл не збережено." });
        return;
      }
      attached = true;
      sendJson(response, 200, { uploaded: true, size: saved.size, instance });
    } catch (error) {
      if (error.statusCode) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    } finally {
      if (saved && !attached) {
        await fs.promises.rm(saved.finalPath, { force: true });
      }
    }
    return;
  }

  const cancelMatch = request.url?.match(/^\/api\/tasks\/(\d{1,19})\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Спочатку увійдіть в акаунт." });
      return;
    }

    const result = await pool.query(
      `WITH selected AS (
         SELECT id, status, storage_name FROM tasks
         WHERE id = $1 AND user_id = $2
           AND status IN ('draft', 'queued', 'processing') FOR UPDATE
       )
       UPDATE tasks AS t
       SET status = 'cancelled',
           updated_at = NOW(), finished_at = NOW()
       FROM selected WHERE t.id = selected.id
       RETURNING selected.status AS previous_status, selected.storage_name`,
      [cancelMatch[1], user.id]
    );

    if (result.rowCount === 0) {
      sendJson(response, 409, { error: "Задача не знайдена або вже не може бути скасована." });
      return;
    }

    const storageName = result.rows[0].storage_name;
    if (storageName && result.rows[0].previous_status !== "processing") {
      const storedPath = path.join(uploadDir, storageName);
      try {
        await fs.promises.rm(storedPath, { force: true });
        await pool.query(
          "UPDATE tasks SET storage_name = NULL WHERE id = $1 AND status = 'cancelled' AND storage_name = $2",
          [cancelMatch[1], storageName]
        );
      } catch (error) {
        console.error("Failed to clean cancelled file:", error.message);
      }
    }

    sendJson(response, 200, { cancelled: true, instance });
    return;
  }

  if (request.method === "POST" && (request.url === "/api/register" || request.url === "/api/login")) {
    let credentials;
    try {
      credentials = await readCredentials(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }

    if (request.url === "/api/register") {
      const passwordHash = await hashPassword(credentials.password);
      try {
        const result = await pool.query(
          "INSERT INTO users (nickname, password_hash) VALUES ($1, $2) RETURNING id, nickname",
          [credentials.nickname, passwordHash]
        );
        await startSession(request, response, result.rows[0]);
      } catch (error) {
        if (error.code === "23505") {
          sendJson(response, 409, { error: "Цей нікнейм уже зайнятий." });
          return;
        }
        throw error;
      }
      return;
    }

    const result = await pool.query(
      "SELECT id, nickname, password_hash FROM users WHERE LOWER(nickname) = LOWER($1)",
      [credentials.nickname]
    );

    if (result.rowCount === 0 || !(await passwordMatches(credentials.password, result.rows[0].password_hash))) {
      sendJson(response, 401, { error: "Неправильний нікнейм або пароль." });
      return;
    }

    await startSession(request, response, result.rows[0]);
    return;
  }

  if (request.method === "POST" && request.url === "/api/logout") {
    const sessionHash = getSessionHash(request);
    if (sessionHash) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sessionHash]);
    }

    setSessionCookie(response, "", 0);
    sendJson(response, 200, { authenticated: false, instance });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

const server = http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    console.error("Request failed:", error.message);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Помилка сервера." });
    } else {
      response.end();
    }
  }
});

server.listen(port, () => {
  console.log(`Server ${instance} running at http://localhost:${port}`);
});
