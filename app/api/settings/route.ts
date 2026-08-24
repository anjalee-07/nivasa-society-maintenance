import { requireAdmin } from "../../../lib/auth";
import { ApiError, handleApiError, noStoreJson, requireSameOrigin } from "../../../lib/api";
import { getDatabase } from "../../../lib/database";

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const overdueDays = Number(payload.overdueDays);
    if (!Number.isInteger(overdueDays) || overdueDays < 1 || overdueDays > 60) {
      throw new ApiError(400, "The overdue threshold must be a whole number from 1 to 60.");
    }
    const db = await getDatabase();
    await db
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('overdue_days', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(String(overdueDays), new Date().toISOString())
      .run();
    return noStoreJson({ ok: true, overdueDays });
  } catch (error) {
    return handleApiError(error);
  }
}
