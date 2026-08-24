import { requireCurrentUser } from "../../../lib/auth";
import { ApiError, handleApiError, noStoreJson, readString, requireSameOrigin } from "../../../lib/api";
import { getDatabase } from "../../../lib/database";

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const name = readString(payload.name, "Name", { min: 2, max: 70 });
    const flatNumber = readString(payload.flatNumber, "Flat number", {
      required: user.role === "resident",
      min: 2,
      max: 30,
    });
    const phone = readString(payload.phone, "Phone number", { required: false, max: 24 });
    if (phone && !/^[+()\d\s-]{7,24}$/.test(phone)) {
      throw new ApiError(400, "Enter a valid phone number.");
    }

    const db = await getDatabase();
    await db
      .prepare("UPDATE users SET name = ?, flat_number = ?, phone = ?, updated_at = ? WHERE id = ?")
      .bind(name, flatNumber || null, phone || null, new Date().toISOString(), user.id)
      .run();
    return noStoreJson({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
