import { ApiError, handleApiError, noStoreJson, readString, requireSameOrigin } from "../../../lib/api";
import { getDatabase } from "../../../lib/database";
import { hashPassword, verifyPassword } from "../../../lib/passwords";
import { clearedCookie, createSession, destroySessionFor, sessionCookie } from "../../../lib/session";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const minPasswordLength = 8;

/**
 * Registration, sign in, and sign out for deployments that do not sit behind a
 * trusted identity proxy. The action is carried in the body so the whole flow
 * lives on one route.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const action = readString(payload.action, "Action", { max: 20 });

    // These are awaited rather than returned directly: a bare `return promise`
    // escapes this try block, so a rejection would bypass handleApiError and
    // surface as a generic 500 instead of its intended status.
    if (action === "logout") return await logout(request);
    if (action === "register") return await register(request, payload);
    if (action === "login") return await login(request, payload);
    throw new ApiError(400, "Unknown authentication action.");
  } catch (error) {
    return handleApiError(error);
  }
}

async function register(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const name = readString(payload.name, "Name", { min: 2, max: 70 });
  const email = readString(payload.email, "Email", { max: 160 }).toLowerCase();
  const password = readString(payload.password, "Password", { max: 200 });
  const flatNumber = readString(payload.flatNumber, "Flat number", {
    required: false,
    max: 30,
  });

  if (!emailPattern.test(email)) throw new ApiError(400, "Enter a valid email address.");
  if (password.length < minPasswordLength) {
    throw new ApiError(400, `Choose a password of at least ${minPasswordLength} characters.`);
  }

  const db = await getDatabase();
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    throw new ApiError(409, "An account already exists for that email address.");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO users
      (id, email, name, flat_number, role, admin_granted, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'resident', 0, ?, ?, ?)`)
    .bind(id, email, name, flatNumber || null, await hashPassword(password), now, now)
    .run();

  const token = await createSession(id);
  return noStoreJson(
    { ok: true },
    { status: 201, headers: { "Set-Cookie": sessionCookie(token, request) } },
  );
}

async function login(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const email = readString(payload.email, "Email", { max: 160 }).toLowerCase();
  const password = readString(payload.password, "Password", { max: 200 });

  const db = await getDatabase();
  const user = await db
    .prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; password_hash: string | null }>();

  // The same message covers an unknown address and a wrong password, so the
  // response cannot be used to discover which accounts exist.
  const invalid = new ApiError(401, "That email and password do not match an account.");
  if (!user?.password_hash) throw invalid;
  if (!(await verifyPassword(password, user.password_hash))) throw invalid;

  const token = await createSession(user.id);
  return noStoreJson(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie(token, request) } },
  );
}

async function logout(request: Request): Promise<Response> {
  await destroySessionFor(request);
  return noStoreJson({ ok: true }, { headers: { "Set-Cookie": clearedCookie(request) } });
}
