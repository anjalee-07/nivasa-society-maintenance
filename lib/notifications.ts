import { waitUntil } from "cloudflare:workers";
import { getAppEnv, getDatabase, type NivasaEnv } from "./database";

/** Attempts after which a message stops retrying without an explicit admin retry. */
const maxAttempts = 5;
/**
 * Messages delivered per drain. Each one costs a provider call plus a write, and
 * a Worker invocation has a finite subrequest budget, so large fan-outs finish
 * across several drains rather than one oversized burst.
 */
const drainBatchSize = 50;

type OutboxRow = {
  id: string;
  email: string;
  subject: string;
  body: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
};

export type DeliveryStatus = "sent" | "pending" | "failed";

export type DrainResult = {
  processed: number;
  sent: number;
  pending: number;
  failed: number;
  remaining: number;
};

/**
 * Whether the provider is fully configured. Reports readiness only — never the
 * key or sender itself — so an administrator can confirm setup took effect
 * without waiting for a message to fail.
 */
export function isEmailConfigured(): boolean {
  return typeof resolveProvider(getAppEnv()) !== "string";
}

export async function deliverNotification(
  outboxId: string,
  options: { force?: boolean } = {},
): Promise<DeliveryStatus> {
  const db = await getDatabase();
  const row = await db
    .prepare(`SELECT id, email, subject, body, status, attempts
      FROM notification_outbox WHERE id = ?`)
    .bind(outboxId)
    .first<OutboxRow>();

  if (!row || row.status === "sent") return row?.status ?? "failed";
  return deliverRow(db, row, options);
}

/**
 * Work through queued and retryable messages, oldest first. Delivery is
 * sequential so a large society does not exhaust the invocation's subrequest
 * budget, and stops early when the provider is unconfigured because every
 * remaining message would report the same gap.
 */
export async function drainOutbox(limit = drainBatchSize): Promise<DrainResult> {
  const db = await getDatabase();
  const rows = await db
    .prepare(`SELECT id, email, subject, body, status, attempts
      FROM notification_outbox
      WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
      ORDER BY created_at ASC LIMIT ?`)
    .bind(maxAttempts, limit)
    .all<OutboxRow>();

  const result: DrainResult = { processed: 0, sent: 0, pending: 0, failed: 0, remaining: 0 };
  for (const row of rows.results) {
    let status: DeliveryStatus;
    try {
      status = await deliverRow(db, row, {});
    } catch {
      status = "failed";
    }
    result.processed += 1;
    result[status] += 1;
    if (status === "pending") break;
  }

  const outstanding = await db
    .prepare(`SELECT COUNT(*) AS count FROM notification_outbox
      WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)`)
    .bind(maxAttempts)
    .first<{ count: number }>();
  result.remaining = Number(outstanding?.count ?? 0);
  return result;
}

/**
 * Hand the outbox to the runtime so a resident's maintenance update is never
 * held open waiting on a third-party email provider. The records are already
 * committed, so a failed drain costs visibility rather than data.
 */
export function queueOutboxDrain(): void {
  waitUntil(
    drainOutbox().catch(() => {
      // Delivery failures are recorded per message; a drain that cannot even
      // reach the database is retried by the next drain or an admin retry.
    }),
  );
}

async function deliverRow(
  db: D1Database,
  row: OutboxRow,
  options: { force?: boolean },
): Promise<DeliveryStatus> {
  const provider = resolveProvider(getAppEnv());
  if (typeof provider === "string") {
    // A configuration gap is not a delivery attempt. The message keeps its full
    // retry budget so nothing is stranded once the provider is set up.
    await db
      .prepare("UPDATE notification_outbox SET last_error = ? WHERE id = ?")
      .bind(provider, row.id)
      .run();
    return "pending";
  }

  if (row.attempts >= maxAttempts && !options.force) return "failed";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": row.id,
      },
      body: JSON.stringify({
        from: provider.from,
        to: [row.email],
        subject: row.subject,
        text: row.body,
        html: renderEmail(row.subject, row.body),
      }),
    });

    if (!response.ok) {
      const providerMessage = await response.text();
      throw new Error(`Email provider returned ${response.status}: ${providerMessage.slice(0, 180)}`);
    }

    await db
      .prepare(`UPDATE notification_outbox
        SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = ?
        WHERE id = ?`)
      .bind(new Date().toISOString(), row.id)
      .run();
    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed";
    await db
      .prepare(`UPDATE notification_outbox
        SET status = 'failed', attempts = attempts + 1, last_error = ?
        WHERE id = ?`)
      .bind(message.slice(0, 300), row.id)
      .run();
    return "failed";
  }
}

/**
 * Resend rejects any sender on its shared `resend.dev` domain other than its own
 * onboarding address, so a missing EMAIL_FROM is a configuration gap rather than
 * something a default can paper over.
 */
function resolveProvider(runtime: NivasaEnv): { apiKey: string; from: string } | string {
  // An operational kill switch for staging and automated tests: keep the full
  // outbox behaviour but never call the provider, so a test run cannot mail
  // real residents.
  if (runtime.EMAIL_DELIVERY_DISABLED === "1") {
    return "Email delivery is disabled in this environment.";
  }
  const apiKey = runtime.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return "Email provider is not configured. Add RESEND_API_KEY to deliver this message.";
  }
  const from = runtime.EMAIL_FROM?.trim();
  if (!from) {
    return "Email sender is not configured. Add a verified EMAIL_FROM address, for example \"Nivasa <notices@yoursociety.com>\", to deliver this message.";
  }
  return { apiKey, from };
}

function renderEmail(subject: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f2;font-family:Arial,sans-serif;color:#17231d">
    <div style="max-width:620px;margin:32px auto;background:#ffffff;border:1px solid #dde4df;border-radius:16px;overflow:hidden">
      <div style="padding:22px 28px;background:#214a31;color:#ffffff;font-size:20px;font-weight:700">Nivasa</div>
      <div style="padding:30px 28px"><h1 style="margin:0 0 16px;font-size:24px">${escapeHtml(subject)}</h1>
      <p style="margin:0;white-space:pre-line;line-height:1.65;color:#536159">${escapeHtml(body)}</p></div>
      <div style="padding:16px 28px;background:#f5f7f4;color:#78847c;font-size:12px">A service update from your society maintenance team.</div>
    </div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}
