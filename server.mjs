import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const applicationsPath = path.join(dataDir, "applications.jsonl");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.HANDMARK_PASSWORD || "Wolfentastic-1";
const DEFAULT_SESSION_SECRET = "handmark-poc-development-secret-change-me";
const SESSION_SECRET =
  process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

if (process.env.NODE_ENV === "production" && SESSION_SECRET === DEFAULT_SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

function isPublicPath(pathname) {
  return (
    pathname === "/login" ||
    pathname === "/styles.css" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/site.webmanifest" ||
    pathname.startsWith("/assets/")
  );
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        if (index === -1) return [cookie, ""];
        return [
          decodeURIComponent(cookie.slice(0, index)),
          decodeURIComponent(cookie.slice(index + 1))
        ];
      })
  );
}

function sign(value) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");
}

function createSessionCookie() {
  const payload = JSON.stringify({
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString("base64url")
  });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function isAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies.hm_session;
  if (!token || !token.includes(".")) return false;

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || sign(encoded) !== signature) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    const ageSeconds = (Date.now() - Number(payload.issuedAt || 0)) / 1000;
    return ageSeconds >= 0 && ageSeconds <= SESSION_MAX_AGE_SECONDS;
  } catch {
    return false;
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

function redirect(response, location) {
  send(response, 302, "", { Location: location });
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function serveFile(response, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const requestedPath = path.normalize(path.join(publicDir, cleanPath));

  if (!requestedPath.startsWith(publicDir)) {
    send(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(requestedPath);
    const type = contentTypes.get(path.extname(requestedPath)) || "application/octet-stream";
    send(response, 200, body, { "Content-Type": type });
  } catch (error) {
    if (error.code === "ENOENT") {
      send(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function handleLogin(request, response) {
  const body = await readBody(request);
  const form = new URLSearchParams(body);
  const submittedPassword = form.get("password") || "";

  if (submittedPassword !== PASSWORD) {
    redirect(response, "/login?error=1");
    return;
  }

  const cookie = [
    `hm_session=${encodeURIComponent(createSessionCookie())}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ].join("; ");

  send(response, 302, "", {
    Location: "/",
    "Set-Cookie": cookie
  });
}

function handleLogout(response) {
  send(response, 302, "", {
    Location: "/login",
    "Set-Cookie": "hm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  });
}

function json(response, status, payload) {
  send(response, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8"
  });
}

function requireField(payload, field) {
  const value = String(payload[field] || "").trim();
  if (!value) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

async function appendApplication(application) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(applicationsPath, `${JSON.stringify(application)}\n`);
}

async function handleApplication(request, response) {
  try {
    const payload = JSON.parse(await readBody(request));
    const plan = requireField(payload, "plan");
    const validPlans = new Set(["verification"]);

    if (!validPlans.has(plan)) {
      throw new Error("Choose a valid plan.");
    }

    if (!payload.agree) {
      throw new Error("Agreement is required.");
    }

    const application = {
      id: `HM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      plan,
      billingCycle: String(payload.billingCycle || "monthly"),
      name: requireField(payload, "name"),
      email: requireField(payload, "email"),
      contactPreference: requireField(payload, "contactPreference"),
      brand: requireField(payload, "brand"),
      website: String(payload.website || "").trim(),
      category: requireField(payload, "category"),
      craftSummary: requireField(payload, "craftSummary"),
      proofLinks: String(payload.proofLinks || "").trim(),
      walkthroughPreference: String(payload.walkthroughPreference || "").trim(),
      paymentPreference: requireField(payload, "paymentPreference")
    };

    await appendApplication(application);
    json(response, 201, {
      ok: true,
      id: application.id,
      message: "Application received. The next step is human review and process walkthrough."
    });
  } catch (error) {
    json(response, 400, {
      ok: false,
      message: error.message || "Could not save the application."
    });
  }
}

async function route(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (request.method === "GET" && isPublicPath(pathname)) {
    await serveFile(response, pathname === "/login" ? "/login.html" : pathname);
    return;
  }

  if (request.method === "POST" && pathname === "/login") {
    await handleLogin(request, response);
    return;
  }

  if (request.method === "POST" && pathname === "/logout") {
    handleLogout(response);
    return;
  }

  if (!isAuthenticated(request)) {
    if (pathname.startsWith("/api/")) {
      json(response, 401, { ok: false, message: "Login required." });
      return;
    }
    redirect(response, "/login");
    return;
  }

  if (request.method === "POST" && pathname === "/api/apply") {
    await handleApplication(request, response);
    return;
  }

  if (request.method !== "GET") {
    send(response, 405, "Method not allowed");
    return;
  }

  await serveFile(response, pathname);
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    send(response, 500, "Internal server error");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Handmark proof of concept running at http://${HOST}:${PORT}`);
});
