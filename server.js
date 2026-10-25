const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Pool } = require("pg");

const port = Number(process.env.PORT) || 3000;
const instance = process.env.INSTANCE_NAME || `api-${port}`;
const page = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const scrypt = promisify(crypto.scrypt);
const sessionLifetime = 7 * 24 * 60 * 60;
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

async function readCredentials(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("Очікується JSON.");
  }

  let body = "";

  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) {
      throw new Error("Завеликий запит.");
    }
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

async function handleRequest(request, response) {
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

  if (request.method === "GET" && request.url === "/api/me") {
    const sessionHash = getSessionHash(request);

    if (!sessionHash) {
      sendJson(response, 200, { authenticated: false, instance });
      return;
    }

    const result = await pool.query(
      "SELECT users.nickname FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()",
      [sessionHash]
    );

    if (result.rowCount === 0) {
      sendJson(response, 200, { authenticated: false, instance });
      return;
    }

    sendJson(response, 200, { authenticated: true, nickname: result.rows[0].nickname, instance });
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
