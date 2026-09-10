import type { NextRequest } from "next/server";
import { readTopicMessages, submitMessage } from "@/lib/hedera/hcs";
import { errorResponse } from "@/lib/hedera/http";

export const runtime = "nodejs";

/** GET /api/hcs/topics/:topicId/messages?limit=&order= — read topic history. */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/hcs/topics/[topicId]/messages">
) {
  try {
    const { topicId } = await ctx.params;
    const { searchParams } = request.nextUrl;

    const limit = Number(searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return Response.json(
        { error: "limit must be an integer between 1 and 100" },
        { status: 400 }
      );
    }

    const order = searchParams.get("order") === "desc" ? "desc" : "asc";
    const messages = await readTopicMessages(topicId, { limit, order });

    return Response.json({ topicId, count: messages.length, messages });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/hcs/topics/:topicId/messages — submit a message. Body: { message } */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/hcs/topics/[topicId]/messages">
) {
  try {
    const { topicId } = await ctx.params;
    const body = await request.json().catch(() => ({}));

    if (body.message === undefined) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const payload =
      typeof body.message === "string"
        ? body.message
        : JSON.stringify(body.message);

    const result = await submitMessage(topicId, payload);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
