import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const BASE = "http://localhost:3000";
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Boot the real worker with its D1 and R2 bindings and wait until it answers.
 * The API routes depend on `cloudflare:workers`, so they cannot be exercised by
 * importing the built bundle in Node; they need the actual runtime.
 */
export async function startServer() {
  await rm(new URL("../../.wrangler", import.meta.url), { recursive: true, force: true });

  const child = spawn("npx", ["vinext", "dev"], {
    cwd: projectRoot,
    // Never let a test run reach the real email provider.
    env: { ...process.env, EMAIL_DELIVERY_DISABLED: "1" },
    shell: process.platform === "win32",
    stdio: "ignore",
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) return child;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await stopServer(child);
  throw new Error("The development server did not become ready in time.");
}

export async function stopServer(child) {
  if (!child) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

/** Call the API as a resident or an administrator. */
export async function api(path, { role = "admin", method = "GET", body, raw = false, headers: extra, cookie } = {}) {
  // `role: null` omits the preview header entirely, which is how a test asks to
  // be treated as an ordinary unauthenticated caller.
  const headers = new Headers({ ...(role ? { "x-nivasa-demo-role": role } : {}), ...(extra ?? {}) });
  if (cookie) headers.set("Cookie", cookie);
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  if (raw) return response;
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

export const BASE_URL = BASE;

/** Smallest valid PNG, used to exercise the signature check with real bytes. */
export function pngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}

export function uniqueKey(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/** Pull the session cookie out of a Set-Cookie header. */
export function sessionCookieFrom(response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/nivasa_session=([^;]*)/);
  return match ? `nivasa_session=${match[1]}` : null;
}

/** Create a complaint as the demo resident and return its id/publicId/version. */
export async function createComplaint(overrides = {}) {
  const form = new FormData();
  form.set("title", overrides.title ?? "Kitchen tap is leaking steadily");
  form.set("category", overrides.category ?? "Plumbing");
  form.set("description", overrides.description ?? "Water drips continuously from the kitchen tap.");
  form.set("location", overrides.location ?? "A-804");
  form.set("idempotencyKey", overrides.idempotencyKey ?? uniqueKey("test"));
  if (overrides.photo) {
    form.set("photo", new Blob([overrides.photo.bytes], { type: overrides.photo.type }), overrides.photo.name);
  }
  return api("/api/complaints", { role: "resident", method: "POST", body: form });
}

/** Read one complaint from the admin bootstrap projection. */
export async function getComplaint(id, role = "admin") {
  const { body } = await api("/api/bootstrap", { role });
  return body.complaints.find((complaint) => complaint.id === id) ?? null;
}
