import { requireCurrentUser } from "../../../../lib/auth";
import { ApiError, handleApiError } from "../../../../lib/api";
import { getAppEnv, getDatabase } from "../../../../lib/database";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireCurrentUser(request);
    const { id } = await context.params;
    const db = await getDatabase();
    const photo = await db
      .prepare(`SELECT p.object_key, p.content_type, p.original_name,
        c.resident_id FROM complaint_photos p
        JOIN complaints c ON c.id = p.complaint_id
        WHERE p.id = ?`)
      .bind(id)
      .first<{
        object_key: string;
        content_type: string;
        original_name: string;
        resident_id: string;
      }>();
    if (!photo) throw new ApiError(404, "Photo not found.");
    if (user.role !== "admin" && photo.resident_id !== user.id) {
      throw new ApiError(403, "You do not have access to this photo.");
    }

    const object = await getAppEnv().UPLOADS.get(photo.object_key);
    if (!object) throw new ApiError(404, "Photo not found in storage.");
    return new Response(object.body, {
      headers: {
        "Content-Type": photo.content_type,
        "Content-Length": String(object.size),
        "Content-Disposition": `inline; filename="${safeHeaderFilename(photo.original_name)}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function safeHeaderFilename(value: string): string {
  return value.replace(/["\\\r\n]/g, "-").slice(0, 100);
}
