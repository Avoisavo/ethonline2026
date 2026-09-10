import type { NextRequest } from "next/server";
import { createTopic } from "@/lib/hedera/hcs";
import { errorResponse } from "@/lib/hedera/http";

export const runtime = "nodejs";

/** POST /api/hcs/topics — create a topic. Body: { memo?, restrictSubmit?, adminKey? } */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const topic = await createTopic({
      memo: typeof body.memo === "string" ? body.memo : undefined,
      restrictSubmit: body.restrictSubmit !== false,
      adminKey: body.adminKey !== false,
    });
    return Response.json(topic, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
