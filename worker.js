const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Pool } = require("pg");

const instance = process.env.INSTANCE_NAME || "worker";
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const conversionTimeout = 120000;
const maxPdfSize = 100 * 1024 * 1024;
const maxUncompressedSize = 150 * 1024 * 1024;
const runCommand = promisify(execFile);
let stopping = false;
let runningProcess = null;

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "webproject",
  user: process.env.DB_USER || "webproject",
  password: process.env.DB_PASSWORD,
  max: 2,
  connectionTimeoutMillis: 3000
});

function stopConversion() {
  if (!runningProcess || !runningProcess.pid) {
    return;
  }

  try {
    process.kill(-runningProcess.pid, "SIGKILL");
  } catch {
    runningProcess.kill("SIGKILL");
  }
}

process.on("SIGTERM", () => {
  stopping = true;
  stopConversion();
});

process.on("SIGINT", () => {
  stopping = true;
  stopConversion();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeTask() {
  const result = await pool.query(
    `WITH next_task AS (
       SELECT id FROM tasks
       WHERE status = 'queued'
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE tasks AS t
     SET status = 'processing', worker_name = $1,
         started_at = NOW(), updated_at = NOW(), error_message = NULL
     FROM next_task WHERE t.id = next_task.id
     RETURNING t.id, t.storage_name`,
    [instance]
  );

  return result.rows[0];
}

async function recoverInterruptedTasks() {
  const result = await pool.query(
    `UPDATE tasks SET status = 'failed',
       error_message = 'Worker зупинився під час конвертації.',
       finished_at = NOW(), updated_at = NOW()
     WHERE status = 'processing'
       AND (worker_name = $1 OR updated_at < NOW() - INTERVAL '45 seconds')
     RETURNING id, worker_name`,
    [instance]
  );

  for (const task of result.rows) {
    console.log(`[${instance}] Recovered interrupted task ${task.id} (${task.worker_name})`);
  }
}

async function cleanupStoredFiles() {
  const result = await pool.query(
    `SELECT id, storage_name FROM tasks
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND storage_name IS NOT NULL
     ORDER BY id LIMIT 20`
  );

  for (const task of result.rows) {
    if (!/^[0-9a-f-]{36}\.pptx$/.test(task.storage_name)) {
      console.error(`[${instance}] Invalid stored filename for task ${task.id}`);
      continue;
    }

    try {
      await fs.promises.rm(path.join(uploadDir, task.storage_name), { force: true });
      await pool.query(
        `UPDATE tasks SET storage_name = NULL
         WHERE id = $1 AND storage_name = $2
           AND status IN ('completed', 'failed', 'cancelled')`,
        [task.id, task.storage_name]
      );
    } catch (error) {
      console.error(`[${instance}] Cannot clean file for task ${task.id}:`, error.message);
    }
  }
}

async function validatePptx(sourcePath) {
  let listing;
  try {
    const result = await runCommand("unzip", ["-l", sourcePath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    listing = result.stdout;
  } catch {
    throw new Error("Некоректний PPTX-файл.");
  }

  let hasPresentation = false;
  let hasContentTypes = false;
  let fileCount = 0;
  let totalSize = 0;

  for (const line of listing.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) {
      continue;
    }

    fileCount++;
    totalSize += Number(match[1]);
    if (fileCount > 2000 || totalSize > maxUncompressedSize) {
      throw new Error("PPTX перевищує ліміт складності.");
    }

    if (match[2] === "ppt/presentation.xml") {
      hasPresentation = true;
    }
    if (match[2] === "[Content_Types].xml") {
      hasContentTypes = true;
    }
  }

  if (!hasPresentation || !hasContentTypes) {
    throw new Error("Некоректний PPTX-файл.");
  }
}

async function taskIsProcessing(id) {
  const result = await pool.query(
    "SELECT status FROM tasks WHERE id = $1 AND worker_name = $2",
    [id, instance]
  );
  return result.rows[0]?.status === "processing";
}

async function updateHeartbeat(id) {
  const result = await pool.query(
    `UPDATE tasks SET updated_at = NOW()
     WHERE id = $1 AND worker_name = $2 AND status = 'processing'
     RETURNING id`,
    [id, instance]
  );
  return result.rowCount > 0;
}

async function runLibreOffice(id, sourcePath, temporaryDir) {
  const profile = path.join(temporaryDir, "profile");
  const child = spawn("libreoffice", [
    `-env:UserInstallation=file://${profile}`,
    "--headless",
    "--convert-to", "pdf:impress_pdf_Export",
    "--outdir", temporaryDir,
    sourcePath
  ], { detached: true, stdio: "ignore" });

  runningProcess = child;
  let timedOut = false;
  let cancelled = false;
  let checking = false;

  const timer = setTimeout(() => {
    timedOut = true;
    stopConversion();
  }, conversionTimeout);

  const monitor = setInterval(async () => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      if (!(await updateHeartbeat(id))) {
        cancelled = true;
        stopConversion();
      }
    } catch (error) {
      console.error(`[${instance}] Cannot check task ${id}:`, error.message);
    } finally {
      checking = false;
    }
  }, 2000);

  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (cancelled || !(await taskIsProcessing(id))) {
      return "cancelled";
    }
    if (timedOut) {
      throw new Error("Перевищено ліміт часу (120 с).");
    }
    if (stopping) {
      throw new Error("Worker зупинено під час конвертації.");
    }
    if (code !== 0) {
      throw new Error("Не вдалося конвертувати PPTX. Перевірте файл.");
    }
    return "completed";
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    runningProcess = null;
  }
}

async function convertTask(task) {
  const inputName = task.storage_name;
  const validName = typeof inputName === "string" && /^[0-9a-f-]{36}\.pptx$/.test(inputName);
  const sourcePath = validName ? path.join(uploadDir, inputName) : null;
  const pdfName = `${crypto.randomUUID()}.pdf`;
  const stagedPath = path.join(uploadDir, `${pdfName}.part`);
  const finalPath = path.join(uploadDir, pdfName);
  let tempDir;
  let outputSaved = false;

  try {
    if (!validName) {
      throw new Error("Файл задачі не знайдено.");
    }

    const inputInfo = await fs.promises.stat(sourcePath);
    if (!inputInfo.isFile() || inputInfo.size > 30 * 1024 * 1024) {
      throw new Error("Неприпустимий розмір PPTX.");
    }
    await validatePptx(sourcePath);

    if (!(await taskIsProcessing(task.id))) {
      return;
    }

    if (stopping) {
      throw new Error("Worker зупинено під час конвертації.");
    }

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "webproject-"));
    console.log(`[${instance}] Starting task ${task.id}`);
    const result = await runLibreOffice(task.id, sourcePath, tempDir);

    if (result === "cancelled") {
      return;
    }

    const generatedPath = path.join(tempDir, `${path.parse(inputName).name}.pdf`);
    const pdfInfo = await fs.promises.stat(generatedPath).catch(() => null);
    if (!pdfInfo || pdfInfo.size < 8 || pdfInfo.size > maxPdfSize) {
      throw new Error("Не вдалося створити коректний PDF.");
    }
    const handle = await fs.promises.open(generatedPath, "r");
    const signature = Buffer.alloc(5);
    try {
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }
    if (signature.toString() !== "%PDF-") {
      throw new Error("Створений файл не є PDF.");
    }

    await fs.promises.copyFile(generatedPath, stagedPath);
    await fs.promises.rename(stagedPath, finalPath);

    const saved = await pool.query(
      `UPDATE tasks SET status = 'completed', progress = 100,
         output_name = $1, finished_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'processing' AND worker_name = $3
       RETURNING id`,
      [pdfName, task.id, instance]
    );

    if (saved.rowCount > 0) {
      outputSaved = true;
      console.log(`[${instance}] Completed task ${task.id}`);
    }
  } catch (error) {
    console.error(`[${instance}] Task ${task.id} failed:`, error.message);
    const knownMessages = [
      "Файл задачі не знайдено.",
      "Неприпустимий розмір PPTX.",
      "Некоректний PPTX-файл.",
      "PPTX перевищує ліміт складності.",
      "Перевищено ліміт часу (120 с).",
      "Worker зупинено під час конвертації.",
      "Не вдалося конвертувати PPTX. Перевірте файл.",
      "Не вдалося створити коректний PDF.",
      "Створений файл не є PDF."
    ];
    const message = knownMessages.includes(error.message)
      ? error.message
      : "Помилка конвертації. Перевірте PPTX або спробуйте інший файл.";
    try {
      await pool.query(
        `UPDATE tasks SET status = 'failed', error_message = $1,
           finished_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND status = 'processing' AND worker_name = $3`,
        [message, task.id, instance]
      );
    } catch (dbError) {
      console.error(`[${instance}] Could not save failure:`, dbError.message);
    }
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(console.error);
    }
    await fs.promises.rm(stagedPath, { force: true }).catch(console.error);
    if (!outputSaved) {
      await fs.promises.rm(finalPath, { force: true }).catch(console.error);
    }
  }
}

async function run() {
  console.log(`[${instance}] Waiting for tasks`);
  while (!stopping) {
    try {
      await recoverInterruptedTasks();
      await cleanupStoredFiles();
      const task = await takeTask();
      if (task) {
        await convertTask(task);
      } else {
        await sleep(2000);
      }
    } catch (error) {
      console.error(`[${instance}] Worker error:`, error.message);
      await sleep(3000);
    }
  }
  await pool.end();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
