import { getDatabase } from "./database";

/**
 * Server-side sessions. The cookie carries only an unguessable identifier; the
 * user it belongs to and its expiry live in the database, so a session can be
 * revoked immediately and nothing about the user is derived from client input.
 */

const cookieName = "nivasa_session";
const lifetimeDays = 30;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export async function createSession(userId: string): Promise<string> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + lifetimeDays * 24 * 60 * 60 * 1000);

  const db = await getDatabase();
  await db
    .prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)`)
    .bind(token, userId, now.toISOString(), expires.toISOString())
    .run();

  // Opportunistic cleanup keeps the table from growing without a scheduled job.
  await db
    .prepare("DELETE FROM sessions WHERE expires_at < ?")
    .bind(now.toISOString())
    .run();

  return token;
}

export async function readSession(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request, cookieName);
  if (!token) return null;

  const db = await getDatabase();
  const row = await db
    .prepare(`SELECT u.id, u.email, u.name, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`)
    .bind(token)
    .first<{ id: string; email: string; name: string; expires_at: string }>();

  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await destroySession(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

export async function destroySessionFor(request: Request): Promise<void> {
  const token = readCookie(request, cookieName);
  if (token) await destroySession(token);
}

async function destroySession(token: string): Promise<void> {
  const db = await getDatabase();
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
}

export function sessionCookie(token: string, request: Request): string {
  return [
    `${cookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${lifetimeDays * 24 * 60 * 60}`,
    ...(isSecure(request) ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(request: Request): string {
  return [
    `${cookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(isSecure(request) ? ["Secure"] : []),
  ].join("; ");
}

/** Local development runs over plain HTTP, where a Secure cookie is discarded. */
function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
