import { requireAdmin } from "../../../lib/auth";
import { ApiError, handleApiError, noStoreJson, readString, requireSameOrigin } from "../../../lib/api";
import { getDatabase } from "../../../lib/database";
import { deliverNotification, drainOutbox } from "../../../lib/notifications";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin(request);
    const payload = (await request.json()) as Record<string, unknown>;

    // Without an id this drains the backlog, which is what an administrator
    // needs after configuring the provider: queued messages are otherwise only
    // reachable one click at a time, and only while they stay in the recent list.
    if (payload.id == null) {
      const result = await drainOutbox();
      return noStoreJson({ ok: result.failed === 0 && result.pending === 0, ...result });
    }

    const id = readString(payload.id, "Notification id", { max: 80 });
    const db = await getDatabase();
    const row = await db
      .prepare("SELECT id FROM notification_outbox WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!row) throw new ApiError(404, "Notification not found.");
    // An explicit retry is a deliberate admin action, so it revives a message
    // that has already exhausted its automatic attempts.
    const status = await deliverNotification(id, { force: true });
    return noStoreJson({ ok: status === "sent", status });
  } catch (error) {
    return handleApiError(error);
  }
}
