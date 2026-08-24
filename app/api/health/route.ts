import { getDatabase } from "../../../lib/database";

export async function GET() {
  try {
    const db = await getDatabase();
    await db.prepare("SELECT 1 AS ok").first();
    return Response.json({ status: "ok", checkedAt: new Date().toISOString() });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
