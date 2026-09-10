import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/hedera/http";
import { loadMarketplace, placeOrder, settleOrder } from "@/lib/marketplace/actions";

export const runtime = "nodejs";

/** GET /api/marketplace/orders — all orders, replayed from the topic. */
export async function GET() {
  try {
    const { orders } = await loadMarketplace();
    return Response.json({ count: orders.length, orders });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/marketplace/orders — place an order, optionally settling payment.
 * Body: { listingId, buyer, quantity?, settle? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    if (typeof body.listingId !== "string" || !body.listingId) {
      return Response.json({ error: "listingId is required" }, { status: 400 });
    }
    if (typeof body.buyer !== "string" || !body.buyer) {
      return Response.json({ error: "buyer is required" }, { status: 400 });
    }

    const quantity = body.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      return Response.json(
        { error: "quantity must be a positive integer" },
        { status: 400 }
      );
    }

    const order = await placeOrder({
      listingId: body.listingId,
      buyer: body.buyer,
      quantity,
    });

    if (body.settle !== true) {
      return Response.json({ ...order, status: "placed" }, { status: 201 });
    }

    // Settlement replays the topic to pick the order up in its reduced form,
    // so the amount paid is the one consensus agreed on, not the one the
    // caller asked for.
    const { orders } = await loadMarketplace();
    const placed = orders.find((o) => o.id === order.id);
    if (!placed) {
      return Response.json(
        { ...order, status: "placed", warning: "Order not yet visible on the mirror node; settle it separately." },
        { status: 202 }
      );
    }

    const { paymentTxId } = await settleOrder(placed);
    return Response.json(
      { ...order, status: "settled", paymentTxId },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
