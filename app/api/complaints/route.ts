import { requireAdmin, requireCurrentUser } from "../../../lib/auth";
import { ApiError, handleApiError, noStoreJson, readString, requireSameOrigin } from "../../../lib/api";
import { getAppEnv, getDatabase } from "../../../lib/database";
import { queueOutboxDrain } from "../../../lib/notifications";

const categories = new Set([
  "Plumbing",
  "Electrical",
  "Lift",
  "Security",
  "Housekeeping",
  "Parking",
  "Other",
]);
const priorities = new Set(["Low", "Medium", "High"]);
const statuses = new Set(["Open", "In Progress", "Resolved"]);
const maxPhotoBytes = 5 * 1024 * 1024;

export async function POST(request: Request) {
  let uploadedObjectKey: string | null = null;
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    if (user.role !== "resident") {
      throw new ApiError(403, "Switch to a resident account to raise a complaint.");
    }
    if (!user.profileComplete) {
      throw new ApiError(409, "Complete your resident profile before raising a complaint.");
    }

    const form = await request.formData();
    const title = readString(form.get("title"), "Title", { min: 4, max: 90 });
    const category = readString(form.get("category"), "Category", { max: 40 });
    const description = readString(form.get("description"), "Description", {
      min: 12,
      max: 1200,
    });
    const location = readString(form.get("location"), "Location", { min: 2, max: 80 });
    const idempotencyKey = readString(form.get("idempotencyKey"), "Request key", {
      min: 8,
      max: 100,
    });
    if (!categories.has(category)) throw new ApiError(400, "Choose a valid complaint category.");

    const db = await getDatabase();
    const existing = await db
      .prepare("SELECT id, public_id FROM complaints WHERE resident_id = ? AND idempotency_key = ?")
      .bind(user.id, idempotencyKey)
      .first<{ id: string; public_id: string }>();
    if (existing) {
      return noStoreJson({
        complaintId: existing.id,
        publicId: existing.public_id,
        duplicate: true,
      });
    }

    const complaintId = crypto.randomUUID();
    const publicId = `SM-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const historyId = crypto.randomUUID();
    const now = new Date().toISOString();
    const photoValue = form.get("photo");
    let photo: {
      id: string;
      objectKey: string;
      originalName: string;
      contentType: string;
      sizeBytes: number;
    } | null = null;

    if (photoValue instanceof File && photoValue.size > 0) {
      if (photoValue.size > maxPhotoBytes) {
        throw new ApiError(413, "The photo must be 5 MB or smaller.");
      }
      const bytes = new Uint8Array(await photoValue.arrayBuffer());
      const detectedType = detectImageType(bytes);
      if (!detectedType) {
        throw new ApiError(415, "Upload a genuine JPG, PNG, or WebP image.");
      }
      const safeName = sanitizeFilename(photoValue.name || "complaint-photo");
      const objectKey = `complaints/${user.id}/${complaintId}/${crypto.randomUUID()}-${safeName}`;
      await getAppEnv().UPLOADS.put(objectKey, bytes, {
        httpMetadata: { contentType: detectedType },
        customMetadata: { ownerId: user.id, complaintId },
      });
      uploadedObjectKey = objectKey;
      photo = {
        id: crypto.randomUUID(),
        objectKey,
        originalName: safeName,
        contentType: detectedType,
        sizeBytes: bytes.byteLength,
      };
    }

    const statements = [
      db.prepare(`INSERT INTO complaints (
        id, public_id, resident_id, title, category, description, location,
        status, priority, idempotency_key, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', 'Medium', ?, 1, ?, ?)`)
        .bind(
          complaintId,
          publicId,
          user.id,
          title,
          category,
          description,
          location,
          idempotencyKey,
          now,
          now,
        ),
      db.prepare(`INSERT INTO complaint_history (
        id, complaint_id, event_type, from_value, to_value,
        actor_id, actor_name, note, created_at
      ) VALUES (?, ?, 'created', NULL, 'Open', ?, ?, ?, ?)`)
        .bind(historyId, complaintId, user.id, user.name, "Complaint raised by resident", now),
    ];
    if (photo) {
      statements.push(
        db.prepare(`INSERT INTO complaint_photos (
          id, complaint_id, object_key, original_name, content_type, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            photo.id,
            complaintId,
            photo.objectKey,
            photo.originalName,
            photo.contentType,
            photo.sizeBytes,
            now,
          ),
      );
    }
    await db.batch(statements);

    return noStoreJson({ complaintId, publicId }, { status: 201 });
  } catch (error) {
    if (uploadedObjectKey) {
      try {
        await getAppEnv().UPLOADS.delete(uploadedObjectKey);
      } catch {
        // A later storage sweep can safely remove this unreferenced object.
      }
    }
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request);
    const admin = await requireAdmin(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const id = readString(payload.id, "Complaint id", { max: 80 });
    const note = readString(payload.note, "Update note", { required: false, max: 500 });
    const expectedVersion = Number(payload.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new ApiError(400, "A valid complaint version is required.");
    }

    const db = await getDatabase();
    const complaint = await db
      .prepare(`SELECT c.id, c.public_id, c.title, c.status, c.priority, c.version,
        c.resident_id, u.email AS resident_email
        FROM complaints c JOIN users u ON u.id = c.resident_id WHERE c.id = ?`)
      .bind(id)
      .first<{
        id: string;
        public_id: string;
        title: string;
        status: "Open" | "In Progress" | "Resolved";
        priority: "Low" | "Medium" | "High";
        version: number;
        resident_id: string;
        resident_email: string;
      }>();
    if (!complaint) throw new ApiError(404, "Complaint not found.");
    if (complaint.version !== expectedVersion) {
      throw new ApiError(409, "This complaint changed in another session. Refresh and try again.");
    }
    if (complaint.status === "Resolved") {
      throw new ApiError(409, "Resolved complaints are closed and cannot be changed.");
    }

    const requestedStatus = payload.status == null ? complaint.status : String(payload.status);
    const requestedPriority = payload.priority == null ? complaint.priority : String(payload.priority);
    if (!statuses.has(requestedStatus)) throw new ApiError(400, "Choose a valid status.");
    if (!priorities.has(requestedPriority)) throw new ApiError(400, "Choose a valid priority.");

    const statusChanged = requestedStatus !== complaint.status;
    const priorityChanged = requestedPriority !== complaint.priority;
    if (!statusChanged && !priorityChanged) {
      throw new ApiError(400, "Choose a new status or priority before saving.");
    }
    if (statusChanged && !isAllowedTransition(complaint.status, requestedStatus)) {
      throw new ApiError(409, `A complaint cannot move from ${complaint.status} to ${requestedStatus}.`);
    }

    const now = new Date().toISOString();
    const result = await db
      .prepare(`UPDATE complaints SET status = ?, priority = ?,
        resolved_at = CASE WHEN ? = 'Resolved' THEN ? ELSE resolved_at END,
        updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status != 'Resolved'`)
      .bind(
        requestedStatus,
        requestedPriority,
        requestedStatus,
        now,
        now,
        id,
        expectedVersion,
      )
      .run();
    if (Number(result.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "This complaint changed in another session. Refresh and try again.");
    }

    const auditStatements = [];
    if (statusChanged) {
      auditStatements.push(
        db.prepare(`INSERT INTO complaint_history (
          id, complaint_id, event_type, from_value, to_value,
          actor_id, actor_name, note, created_at
        ) VALUES (?, ?, 'status_changed', ?, ?, ?, ?, ?, ?)`)
          .bind(
            crypto.randomUUID(),
            id,
            complaint.status,
            requestedStatus,
            admin.id,
            admin.name,
            note || null,
            now,
          ),
      );
    }
    if (priorityChanged) {
      auditStatements.push(
        db.prepare(`INSERT INTO complaint_history (
          id, complaint_id, event_type, from_value, to_value,
          actor_id, actor_name, note, created_at
        ) VALUES (?, ?, 'priority_changed', ?, ?, ?, ?, ?, ?)`)
          .bind(
            crypto.randomUUID(),
            id,
            complaint.priority,
            requestedPriority,
            admin.id,
            admin.name,
            note || null,
            now,
          ),
      );
    }

    let outboxId: string | null = null;
    if (statusChanged) {
      outboxId = crypto.randomUUID();
      const body = [
        `${complaint.public_id}: ${complaint.title}`,
        `Status: ${requestedStatus}`,
        note ? `Update from the society team: ${note}` : "The society team has updated your request.",
        "Sign in to Nivasa to view the complete timeline.",
      ].join("\n\n");
      auditStatements.push(
        db.prepare(`INSERT INTO notification_outbox (
          id, dedupe_key, user_id, email, type, subject, body,
          status, attempts, created_at
        ) VALUES (?, ?, ?, ?, 'status_change', ?, ?, 'pending', 0, ?)`)
          .bind(
            outboxId,
            `status:${id}:${expectedVersion + 1}`,
            complaint.resident_id,
            complaint.resident_email,
            `${complaint.public_id} is now ${requestedStatus}`,
            body,
            now,
          ),
      );
    }
    if (auditStatements.length) await db.batch(auditStatements);

    // The complaint update is already durable. Delivery runs after the response
    // so an administrator never waits on the email provider.
    if (outboxId) queueOutboxDrain();
    return noStoreJson({
      ok: true,
      version: expectedVersion + 1,
      delivery: outboxId ? "queued" : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function isAllowedTransition(current: string, next: string): boolean {
  if (current === "Open") return next === "In Progress" || next === "Resolved";
  if (current === "In Progress") return next === "Resolved";
  return false;
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return cleaned || "complaint-photo";
}

function detectImageType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}
