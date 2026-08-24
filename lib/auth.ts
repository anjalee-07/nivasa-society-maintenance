import { getChatGPTUser } from "../app/chatgpt-auth";
import { ApiError } from "./api";
import { getAppEnv, getDatabase } from "./database";
import { readSession } from "./session";

export type UserRole = "resident" | "admin";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  flatNumber: string | null;
  phone: string | null;
  role: UserRole;
  profileComplete: boolean;
  isDemo: boolean;
};

type Identity = {
  id: string;
  email: string;
  name: string;
  preferredRole: UserRole;
  isDemo: boolean;
};

export async function requireCurrentUser(request: Request): Promise<CurrentUser> {
  const identity = await resolveIdentity(request);
  if (!identity) {
    throw new ApiError(401, "Please sign in to continue.");
  }

  const db = await getDatabase();
  const adminEmails = new Set(
    (getAppEnv().ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const requestedRole =
    identity.preferredRole === "admin" || adminEmails.has(identity.email.toLowerCase())
      ? "admin"
      : "resident";
  const now = new Date().toISOString();

  // The allowlist is authoritative in both directions: an email that leaves
  // ADMIN_EMAILS is demoted on its next request. `name` is deliberately not
  // synced, because residents may edit it through the profile form. A role
  // granted through the invite code sets `admin_granted` and therefore survives
  // this re-sync, which would otherwise revert it on the very next request.
  await db
    .prepare(`INSERT INTO users
      (id, email, name, role, admin_granted, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        role = CASE WHEN users.admin_granted = 1 THEN 'admin' ELSE excluded.role END,
        updated_at = excluded.updated_at`)
    .bind(identity.id, identity.email, identity.name, requestedRole, now, now)
    .run();

  const row = await db
    .prepare(`SELECT id, email, name, flat_number, phone, role
      FROM users WHERE id = ?`)
    .bind(identity.id)
    .first<{
      id: string;
      email: string;
      name: string;
      flat_number: string | null;
      phone: string | null;
      role: UserRole;
    }>();

  if (!row) throw new ApiError(500, "Your profile could not be loaded.");
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    flatNumber: row.flat_number,
    phone: row.phone,
    role: row.role,
    profileComplete: row.role === "admin" || Boolean(row.flat_number?.trim()),
    isDemo: identity.isDemo,
  };
}

export async function requireAdmin(request: Request): Promise<CurrentUser> {
  const user = await requireCurrentUser(request);
  if (user.role !== "admin") {
    throw new ApiError(403, "This action is available to society administrators only.");
  }
  return user;
}

async function resolveIdentity(request: Request): Promise<Identity | null> {
  // The `oai-authenticated-user-*` headers are only trustworthy behind a proxy
  // that strips them from inbound requests and injects them after
  // authenticating. Anywhere else any caller could set them by hand and
  // impersonate anyone, so trusting them is opt-in per deployment rather than
  // the default.
  if (getAppEnv().TRUST_PLATFORM_IDENTITY === "1") {
    const platformUser = await getChatGPTUser();
    if (platformUser) {
      return {
        id: platformUser.userId,
        email: platformUser.email,
        name: platformUser.displayName,
        preferredRole: "resident",
        isDemo: false,
      };
    }
  }

  const session = await readSession(request);
  if (session) {
    return {
      id: session.id,
      email: session.email,
      name: session.name,
      preferredRole: "resident",
      isDemo: false,
    };
  }

  const url = new URL(request.url);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocal) return null;

  // The preview role must be asked for explicitly. Defaulting to admin when the
  // header is absent would authenticate every anonymous local request, and would
  // hide the real sign-in flow during development.
  const requested = request.headers.get("x-nivasa-demo-role");
  if (requested !== "resident" && requested !== "admin") return null;
  const role = requested;
  return role === "admin"
    ? {
        id: "demo-admin",
        email: "admin@nivasa.local",
        name: "Rohan Mehta",
        preferredRole: "admin",
        isDemo: true,
      }
    : {
        id: "demo-resident",
        // Must match the seeded address, because the identity upsert re-syncs
        // email on every request and would otherwise overwrite it.
        email: getAppEnv().DEMO_RESIDENT_EMAIL?.trim() || "priya@nivasa.local",
        name: "Priya Shah",
        preferredRole: "resident",
        isDemo: true,
      };
}
