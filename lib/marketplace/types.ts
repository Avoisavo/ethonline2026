/**
 * Marketplace events. The HCS topic is the source of truth: every mutation is
 * an append-only message, and current state is a reduction over the topic in
 * consensus order. Nothing is ever edited or deleted in place — a cancellation
 * is its own event, which is what makes the whole history auditable.
 */

export const MARKETPLACE_PROTOCOL = "mkt-1";

export type MarketplaceEvent =
  | ListingCreated
  | ListingCancelled
  | OrderPlaced
  | OrderSettled;

interface EventBase {
  /** Protocol tag, so one topic can carry unrelated traffic safely. */
  p: typeof MARKETPLACE_PROTOCOL;
  op: string;
}

export interface ListingCreated extends EventBase {
  op: "listing.create";
  /** Client-generated id; the seller picks it so orders can reference it. */
  id: string;
  seller: string;
  title: string;
  description?: string;
  /** Price in tinybars (1 HBAR = 100_000_000 tinybars). Integer, as a string. */
  priceTinybars: string;
  quantity: number;
}

export interface ListingCancelled extends EventBase {
  op: "listing.cancel";
  id: string;
  seller: string;
}

export interface OrderPlaced extends EventBase {
  op: "order.place";
  /** Order id. */
  id: string;
  listingId: string;
  buyer: string;
  quantity: number;
}

export interface OrderSettled extends EventBase {
  op: "order.settle";
  id: string;
  /** Transaction id of the transfer that paid the seller. */
  paymentTxId?: string;
}

export type ListingStatus = "active" | "sold_out" | "cancelled";

export interface Listing {
  id: string;
  seller: string;
  title: string;
  description?: string;
  priceTinybars: string;
  quantity: number;
  /** Units still available after subtracting placed orders. */
  remaining: number;
  status: ListingStatus;
  sequenceNumber: number;
  createdAt: string;
}

export type OrderStatus = "placed" | "settled";

export interface Order {
  id: string;
  listingId: string;
  buyer: string;
  quantity: number;
  totalTinybars: string;
  status: OrderStatus;
  paymentTxId?: string;
  sequenceNumber: number;
  placedAt: string;
}

export interface MarketplaceState {
  listings: Listing[];
  orders: Order[];
}
