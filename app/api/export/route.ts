import { exportJson } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const state = await exportJson();
  return Response.json(state, {
    headers: {
      "Content-Disposition": `attachment; filename="mutation-radar-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
