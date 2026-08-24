import { requireAdmin } from "../../../lib/auth";
import { handleApiError, noStoreJson, readString, requireSameOrigin } from "../../../lib/api";
import { getDatabase } from "../../../lib/database";
import { queueOutboxDrain } from "../../../lib/notifications";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const admin = await requireAdmin(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const title = readString(payload.title, "Notice title", { min: 4, max: 110 });
    const body = readString(payload.body, "Notice details", { min: 12, max: 1800 });
    const important = payload.important === true;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = await getDatabase();

    await db
      .prepare(`INSERT INTO notices (
        id, title, body, important, created_by, author_name, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, title, body, important ? 1 : 0, admin.id, admin.name, now)
      .run();

    const outboxIds: string[] = [];
    if (important) {
      const residents = await db
        .prepare("SELECT id, email FROM users WHERE role = 'resident' AND email != ''")
        .all<{ id: string; email: string }>();
      const messages = residents.results.map((resident) => {
        const outboxId = crypto.randomUUID();
        outboxIds.push(outboxId);
        return db.prepare(`INSERT OR IGNORE INTO notification_outbox (
          id, dedupe_key, user_id, email, type, subject, body,
          status, attempts, created_at
        ) VALUES (?, ?, ?, ?, 'important_notice', ?, ?, 'pending', 0, ?)`)
          .bind(
            outboxId,
            `notice:${id}:${resident.id}`,
            resident.id,
            resident.email,
            `Important notice: ${title}`,
            `${body}\n\nPosted by ${admin.name}. Sign in to Nivasa for the complete notice board.`,
            now,
          );
      });
      if (messages.length) await db.batch(messages);
    }

    // The notice and its outbox records are committed. Fan-out happens after
    // the response instead of holding it open for one provider call per
    // resident, which would also risk the invocation subrequest budget.
    if (outboxIds.length) queueOutboxDrain();
    return noStoreJson(
      { id, notifiedResidents: outboxIds.length },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const id = readString(payload.id, "Notice id", { max: 80 });
    const db = await getDatabase();
    await db.prepare("DELETE FROM notices WHERE id = ?").bind(id).run();
    return noStoreJson({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
