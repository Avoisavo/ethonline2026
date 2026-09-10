import { randomUUID } from "crypto";
import { AccountId, Hbar, HbarUnit, TransferTransaction } from "@hashgraph/sdk";
import { getClient } from "@/lib/hedera/client";
import { readTopicMessages, submitJson } from "@/lib/hedera/hcs";
import { reduceMarketplace } from "@/lib/marketplace/state";
import {
  MARKETPLACE_PROTOCOL,
  type MarketplaceState,
  type Order,
} from "@/lib/marketplace/types";

/** The topic every marketplace event is written to. */
export function getMarketplaceTopicId(): string {
  const topicId = process.env.MARKETPLACE_TOPIC_ID;
  if (!topicId) {
    throw new Error("Missing MARKETPLACE_TOPIC_ID in environment variables");
  }
  return topicId;
}

/** Replay the topic and fold it into current state. */
export async function loadMarketplace(
  limit = 100
): Promise<MarketplaceState> {
  const messages = await readTopicMessages(getMarketplaceTopicId(), { limit });
  return reduceMarketplace(messages);
}

export async function createListing(input: {
  seller: string;
  title: string;
  description?: string;
  priceTinybars: string;
  quantity: number;
}): Promise<{ id: string; sequenceNumber: number }> {
  const id = randomUUID();
  const result = await submitJson(getMarketplaceTopicId(), {
    p: MARKETPLACE_PROTOCOL,
    op: "listing.create",
    id,
    ...input,
  });
  return { id, sequenceNumber: result.sequenceNumber };
}

export async function cancelListing(input: {
  id: string;
  seller: string;
}): Promise<{ sequenceNumber: number }> {
  const result = await submitJson(getMarketplaceTopicId(), {
    p: MARKETPLACE_PROTOCOL,
    op: "listing.cancel",
    ...input,
  });
  return { sequenceNumber: result.sequenceNumber };
}

/**
 * Place an order. Validated against replayed state before the event is written
 * so the common failures (missing listing, oversold, cancelled) surface as a
 * 4xx instead of becoming an event the reducer silently drops.
 *
 * This check is advisory, not a lock: two orders submitted at the same instant
 * can both pass here and only one will survive the reduction. The reducer is
 * the authority, and it settles the race by consensus order.
 */
export async function placeOrder(input: {
  listingId: string;
  buyer: string;
  quantity: number;
}): Promise<{ id: string; totalTinybars: string; sequenceNumber: number }> {
  const { listings } = await loadMarketplace();
  const listing = listings.find((l) => l.id === input.listingId);

  if (!listing) {
    throw new MarketplaceError(`Unknown listing ${input.listingId}`, 404);
  }
  if (listing.status !== "active") {
    throw new MarketplaceError(`Listing is ${listing.status}`, 409);
  }
  if (input.quantity < 1 || input.quantity > listing.remaining) {
    throw new MarketplaceError(
      `Only ${listing.remaining} unit(s) remaining`,
      409
    );
  }

  const id = randomUUID();
  const result = await submitJson(getMarketplaceTopicId(), {
    p: MARKETPLACE_PROTOCOL,
    op: "order.place",
    id,
    ...input,
  });

  return {
    id,
    totalTinybars: (
      BigInt(listing.priceTinybars) * BigInt(input.quantity)
    ).toString(),
    sequenceNumber: result.sequenceNumber,
  };
}

/**
 * Pay the seller and record settlement.
 *
 * The transfer debits the operator account, because the operator is the only
 * key this server holds. That is fine for a demo, where the operator stands in
 * for an escrow account; a production marketplace would have the buyer sign
 * their own debit — either client-side via a wallet, or with a scheduled
 * transaction the buyer signs out of band.
 */
export async function settleOrder(order: Order): Promise<{ paymentTxId: string }> {
  const { listings } = await loadMarketplace();
  const listing = listings.find((l) => l.id === order.listingId);
  if (!listing) {
    throw new MarketplaceError(`Unknown listing ${order.listingId}`, 404);
  }

  const client = getClient();
  const operatorId = client.operatorAccountId!;
  const amount = Hbar.from(order.totalTinybars, HbarUnit.Tinybar);

  const response = await new TransferTransaction()
    .addHbarTransfer(operatorId, amount.negated())
    .addHbarTransfer(AccountId.fromString(listing.seller), amount)
    .execute(client);

  await response.getReceipt(client);
  const paymentTxId = response.transactionId.toString();

  await submitJson(getMarketplaceTopicId(), {
    p: MARKETPLACE_PROTOCOL,
    op: "order.settle",
    id: order.id,
    paymentTxId,
  });

  return { paymentTxId };
}

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}
