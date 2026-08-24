import { requireCurrentUser } from "../../../lib/auth";
import { handleApiError, noStoreJson } from "../../../lib/api";
import { getDatabase } from "../../../lib/database";
import { isEmailConfigured } from "../../../lib/notifications";

type ComplaintRow = {
  id: string;
  public_id: string;
  resident_id: string;
  resident_name: string;
  resident_email: string;
  resident_flat: string | null;
  title: string;
  category: string;
  description: string;
  location: string;
  status: "Open" | "In Progress" | "Resolved";
  priority: "Low" | "Medium" | "High";
  version: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  is_overdue: number;
};

type HistoryRow = {
  id: string;
  complaint_id: string;
  event_type: string;
  from_value: string | null;
  to_value: string;
  actor_name: string;
  note: string | null;
  created_at: string;
};

type PhotoRow = {
  id: string;
  complaint_id: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
};

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    const db = await getDatabase();
    const settingsResult = await db
      .prepare("SELECT key, value FROM settings")
      .all<{ key: string; value: string }>();
    const settings = Object.fromEntries(
      settingsResult.results.map((row) => [row.key, row.value]),
    );
    const overdueDays = clamp(Number(settings.overdue_days || 3), 1, 60);
    const residentFilter = user.role === "resident" ? "WHERE c.resident_id = ?" : "";

    const complaintsQuery = db.prepare(`SELECT
      c.id, c.public_id, c.resident_id, u.name AS resident_name,
      u.email AS resident_email, u.flat_number AS resident_flat,
      c.title, c.category, c.description, c.location, c.status, c.priority,
      c.version, c.created_at, c.updated_at, c.resolved_at,
      CASE WHEN c.status != 'Resolved'
        AND (julianday('now') - julianday(c.created_at)) >= ?
        THEN 1 ELSE 0 END AS is_overdue
      FROM complaints c
      JOIN users u ON u.id = c.resident_id
      ${residentFilter}
      ORDER BY is_overdue DESC,
        CASE c.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
        c.created_at DESC`);
    const complaintsResult = user.role === "resident"
      ? await complaintsQuery.bind(overdueDays, user.id).all<ComplaintRow>()
      : await complaintsQuery.bind(overdueDays).all<ComplaintRow>();

    const relatedFilter = user.role === "resident" ? "WHERE c.resident_id = ?" : "";
    const historyQuery = db.prepare(`SELECT h.id, h.complaint_id, h.event_type,
      h.from_value, h.to_value, h.actor_name, h.note, h.created_at
      FROM complaint_history h
      JOIN complaints c ON c.id = h.complaint_id
      ${relatedFilter}
      ORDER BY h.created_at DESC`);
    const photoQuery = db.prepare(`SELECT p.id, p.complaint_id, p.original_name,
      p.content_type, p.size_bytes
      FROM complaint_photos p
      JOIN complaints c ON c.id = p.complaint_id
      ${relatedFilter}`);
    const noticeQuery = db.prepare(`SELECT id, title, body, important,
      author_name, published_at FROM notices
      ORDER BY important DESC, published_at DESC`);
    const notificationQuery = db.prepare(`SELECT id, type, subject, status,
      attempts, last_error, created_at, sent_at, email
      FROM notification_outbox
      ${user.role === "resident" ? "WHERE user_id = ?" : ""}
      ORDER BY created_at DESC LIMIT 50`);
    // The list above is capped, so totals are counted separately. Otherwise a
    // backlog larger than the page silently under-reports itself.
    const notificationTotalsQuery = db.prepare(`SELECT status, COUNT(*) AS count
      FROM notification_outbox
      ${user.role === "resident" ? "WHERE user_id = ?" : ""}
      GROUP BY status`);

    const [historyResult, photoResult, noticeResult, notificationResult, notificationTotals] =
      await Promise.all([
        user.role === "resident"
          ? historyQuery.bind(user.id).all<HistoryRow>()
          : historyQuery.all<HistoryRow>(),
        user.role === "resident"
          ? photoQuery.bind(user.id).all<PhotoRow>()
          : photoQuery.all<PhotoRow>(),
        noticeQuery.all<{
          id: string;
          title: string;
          body: string;
          important: number;
          author_name: string;
          published_at: string;
        }>(),
        user.role === "resident"
          ? notificationQuery.bind(user.id).all<{
              id: string;
              type: string;
              subject: string;
              status: string;
              attempts: number;
              last_error: string | null;
              created_at: string;
              sent_at: string | null;
              email: string;
            }>()
          : notificationQuery.all<{
              id: string;
              type: string;
              subject: string;
              status: string;
              attempts: number;
              last_error: string | null;
              created_at: string;
              sent_at: string | null;
              email: string;
            }>(),
        user.role === "resident"
          ? notificationTotalsQuery.bind(user.id).all<{ status: string; count: number }>()
          : notificationTotalsQuery.all<{ status: string; count: number }>(),
      ]);

    const deliverySummary = { sent: 0, pending: 0, failed: 0 };
    for (const row of notificationTotals.results) {
      if (row.status in deliverySummary) {
        deliverySummary[row.status as keyof typeof deliverySummary] = Number(row.count ?? 0);
      }
    }

    const historyByComplaint = groupBy(historyResult.results, (row) => row.complaint_id);
    const photosByComplaint = groupBy(photoResult.results, (row) => row.complaint_id);
    const complaints = complaintsResult.results.map((row) => ({
      id: row.id,
      publicId: row.public_id,
      residentId: row.resident_id,
      residentName: row.resident_name,
      residentEmail: row.resident_email,
      residentFlat: row.resident_flat,
      title: row.title,
      category: row.category,
      description: row.description,
      location: row.location,
      status: row.status,
      priority: row.priority,
      version: row.version,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
      isOverdue: Boolean(row.is_overdue),
      history: (historyByComplaint.get(row.id) ?? []).map((event) => ({
        id: event.id,
        eventType: event.event_type,
        fromValue: event.from_value,
        toValue: event.to_value,
        actorName: event.actor_name,
        note: event.note,
        createdAt: toIso(event.created_at),
      })),
      photos: (photosByComplaint.get(row.id) ?? []).map((photo) => ({
        id: photo.id,
        name: photo.original_name,
        contentType: photo.content_type,
        sizeBytes: photo.size_bytes,
        url: `/api/photos/${photo.id}`,
      })),
    }));

    const statusCounts = { Open: 0, "In Progress": 0, Resolved: 0 };
    const categoryCounts: Record<string, number> = {};
    let overdueCount = 0;
    for (const complaint of complaints) {
      statusCounts[complaint.status] += 1;
      categoryCounts[complaint.category] = (categoryCounts[complaint.category] ?? 0) + 1;
      if (complaint.isOverdue) overdueCount += 1;
    }

    return noStoreJson({
      user,
      settings: {
        overdueDays,
        societyName: settings.society_name || "Greenwood Residency",
        societyLocation: settings.society_location || "Bengaluru",
      },
      complaints,
      notices: noticeResult.results.map((notice) => ({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        important: Boolean(notice.important),
        authorName: notice.author_name,
        publishedAt: toIso(notice.published_at),
      })),
      notifications: notificationResult.results.map((item) => ({
        id: item.id,
        type: item.type,
        subject: item.subject,
        status: item.status,
        attempts: item.attempts,
        lastError: item.last_error,
        createdAt: toIso(item.created_at),
        sentAt: item.sent_at ? toIso(item.sent_at) : null,
        email: item.email,
      })),
      deliverySummary,
      emailConfigured: user.role === "admin" ? isEmailConfigured() : null,
      dashboard: { statusCounts, categoryCounts, overdueCount },
      serverNow: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function toIso(value: string): string {
  if (value.includes("T")) return value.endsWith("Z") ? value : `${value}Z`;
  return `${value.replace(" ", "T")}Z`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
