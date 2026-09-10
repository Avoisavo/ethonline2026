import type { TopicMessage } from "@/lib/hedera/hcs";
import {
  MARKETPLACE_PROTOCOL,
  type Listing,
  type MarketplaceEvent,
  type MarketplaceState,
  type Order,
} from "@/lib/marketplace/types";

function isMarketplaceEvent(value: unknown): value is MarketplaceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { p?: unknown }).p === MARKETPLACE_PROTOCOL &&
    typeof (value as { op?: unknown }).op === "string"
  );
}

/**
 * Fold the topic's messages into current state.
 *
 * Consensus order makes this deterministic: every reader that replays the same
 * topic arrives at the same result, which is the whole point of putting the
 * log on HCS rather than in a database.
 *
 * Note what this does NOT give you: HCS orders messages, it does not authorize
 * them. The `seller` and `buyer` fields are self-asserted by whoever submitted
 * the message. Rules below reject events that contradict earlier state (a
 * cancel from a non-seller, an oversold listing), but a topic with an open
 * submit key still lets anyone append a plausible-looking event under someone
 * else's name. Binding an identity to a key is a separate problem — see the
 * note in the route handlers.
 */
export function reduceMarketplace(messages: TopicMessage[]): MarketplaceState {
  const listings = new Map<string, Listing>();
  const orders = new Map<string, Order>();

  for (const msg of messages) {
    const event = msg.contents;
    if (!isMarketplaceEvent(event)) continue;

    switch (event.op) {
      case "listing.create": {
        // First writer of an id wins; a replay cannot overwrite a listing.
        if (listings.has(event.id)) break;
        if (event.quantity < 1) break;

        listings.set(event.id, {
          id: event.id,
          seller: event.seller,
          title: event.title,
          description: event.description,
          priceTinybars: event.priceTinybars,
          quantity: event.quantity,
          remaining: event.quantity,
          status: "active",
          sequenceNumber: msg.sequenceNumber,
          createdAt: msg.consensusTimestamp,
        });
        break;
      }

      case "listing.cancel": {
        const listing = listings.get(event.id);
        if (!listing) break;
        // Only the account that created the listing may retire it.
        if (listing.seller !== event.seller) break;
        if (listing.status === "cancelled") break;

        listing.status = "cancelled";
        break;
      }

      case "order.place": {
        if (orders.has(event.id)) break;

        const listing = listings.get(event.listingId);
        if (!listing) break;
        if (listing.status !== "active") break;
        if (event.quantity < 1 || event.quantity > listing.remaining) break;

        listing.remaining -= event.quantity;
        if (listing.remaining === 0) listing.status = "sold_out";

        orders.set(event.id, {
          id: event.id,
          listingId: event.listingId,
          buyer: event.buyer,
          quantity: event.quantity,
          totalTinybars: (
            BigInt(listing.priceTinybars) * BigInt(event.quantity)
          ).toString(),
          status: "placed",
          sequenceNumber: msg.sequenceNumber,
          placedAt: msg.consensusTimestamp,
        });
        break;
      }

      case "order.settle": {
        const order = orders.get(event.id);
        if (!order) break;
        if (order.status === "settled") break;

        order.status = "settled";
        order.paymentTxId = event.paymentTxId;
        break;
      }
    }
  }

  return {
    listings: [...listings.values()],
    orders: [...orders.values()],
  };
}
