import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/hedera/http";
import { createListing, loadMarketplace } from "@/lib/marketplace/actions";

export const runtime = "nodejs";

/** GET /api/marketplace/listings — current listings, replayed from the topic. */
export async function GET() {
  try {
    const { listings } = await loadMarketplace();
    return Response.json({ count: listings.length, listings });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/marketplace/listings — publish a listing.
 *
 * `seller` is taken from the body, which means this endpoint trusts its caller.
 * Put real authentication in front of it before exposing it: the account in the
 * event should come from a verified session, not from user input.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const missing = ["seller", "title", "priceTinybars"].filter(
      (field) => typeof body[field] !== "string" || !body[field]
    );
    if (missing.length) {
      return Response.json(
        { error: `Missing or invalid: ${missing.join(", ")}` },
        { status: 400 }
      );
    }

    if (!/^\d+$/.test(body.priceTinybars)) {
      return Response.json(
        { error: "priceTinybars must be a whole number of tinybars" },
        { status: 400 }
      );
    }

    const quantity = body.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      return Response.json(
        { error: "quantity must be a positive integer" },
        { status: 400 }
      );
    }

    const listing = await createListing({
      seller: body.seller,
      title: body.title,
      description:
        typeof body.description === "string" ? body.description : undefined,
      priceTinybars: body.priceTinybars,
      quantity,
    });

    return Response.json(listing, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
