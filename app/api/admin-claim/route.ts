import { requireCurrentUser } from "../../../lib/auth";
import { ApiError, handleApiError, noStoreJson, readString, requireSameOrigin } from "../../../lib/api";
import { getAppEnv, getDatabase } from "../../../lib/database";

/**
 * Grant the signed-in user the administrator role in exchange for a shared
 * invite code.
 *
 * `ADMIN_EMAILS` remains the normal way to appoint administrators, but it
 * requires knowing an address in advance. A reviewer opening a hosted
 * deployment cannot be listed ahead of time, and would otherwise only ever see
 * the resident half of the application. The code is opt-in: with
 * `ADMIN_INVITE_CODE` unset this route does not exist at all.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const configuredCode = getAppEnv().ADMIN_INVITE_CODE?.trim();
    // Absent configuration is reported as an unknown route rather than a
    // refusal, so the endpoint reveals nothing when the feature is disabled.
    if (!configuredCode) throw new ApiError(404, "Not found.");

    const user = await requireCurrentUser(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const supplied = readString(payload.code, "Invite code", { max: 200 });

    if (!matches(supplied, configuredCode)) {
      throw new ApiError(403, "That invite code is not valid.");
    }
    if (user.role === "admin") {
      return noStoreJson({ ok: true, role: "admin", alreadyAdmin: true });
    }

    const db = await getDatabase();
    await db
      .prepare(`UPDATE users SET role = 'admin', admin_granted = 1, updated_at = ?
        WHERE id = ?`)
      .bind(new Date().toISOString(), user.id)
      .run();

    return noStoreJson({ ok: true, role: "admin", alreadyAdmin: false });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Compare in constant time so a wrong code cannot be recovered by measuring how
 * quickly it is rejected.
 */
function matches(supplied: string, configured: string): boolean {
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(configured);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
