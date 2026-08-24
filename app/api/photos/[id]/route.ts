import { requireCurrentUser } from "../../../../lib/auth";
import { ApiError, handleApiError } from "../../../../lib/api";
import { getDatabase } from "../../../../lib/database";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireCurrentUser(request);
    const { id } = await context.params;
    const db = await getDatabase();
    const photo = await db
      .prepare(`SELECT p.data, p.content_type, p.original_name, p.size_bytes,
        c.resident_id FROM complaint_photos p
        JOIN complaints c ON c.id = p.complaint_id
        WHERE p.id = ?`)
      .bind(id)
      .first<{
        data: ArrayBuffer | number[] | null;
        content_type: string;
        original_name: string;
        size_bytes: number;
        resident_id: string;
      }>();
    if (!photo) throw new ApiError(404, "Photo not found.");
    // Ownership is re-checked here rather than trusted from the caller: the
    // photo id alone must never be enough to read another resident's image.
    if (user.role !== "admin" && photo.resident_id !== user.id) {
      throw new ApiError(403, "You do not have access to this photo.");
    }

    const bytes = toBytes(photo.data);
    if (!bytes) throw new ApiError(404, "Photo not found in storage.");

    return new Response(bytes, {
      headers: {
        "Content-Type": photo.content_type,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `inline; filename="${safeHeaderFilename(photo.original_name)}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * D1 returns a BLOB as an ArrayBuffer, but a plain array of byte values is also
 * possible depending on the driver, so both shapes are accepted.
 */
function toBytes(value: ArrayBuffer | number[] | null): ArrayBuffer | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) {
    return value.byteLength > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? new Uint8Array(value).buffer : null;
  }
  return null;
}

function safeHeaderFilename(value: string): string {
  return value.replace(/["\\\r\n]/g, "-").slice(0, 100);
}
