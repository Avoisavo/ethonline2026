import { loadMarketplace } from "@/lib/marketplace/actions";
import type { MarketplaceState } from "@/lib/marketplace/types";
import { BuyButton, NewListingForm } from "./actions-client";

// State is replayed from the topic on every request, so never cache it.
export const dynamic = "force-dynamic";

const HBAR = BigInt(100_000_000);

function formatHbar(tinybars: string): string {
  const value = BigInt(tinybars);
  const whole = value / HBAR;
  const fraction = (value % HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export default async function MarketplacePage() {
  let state: MarketplaceState | null = null;
  let error: string | null = null;

  try {
    state = await loadMarketplace();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const account = process.env.HEDERA_OPERATOR_ID ?? "0.0.0";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Marketplace</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Every listing and order is a message on an HCS topic. This page is a
          replay of that log — nothing here is stored server-side.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium">Not configured</p>
          <p className="mt-1">{error}</p>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Set the Hedera vars in <code>.env</code>, create a topic with{" "}
            <code>POST /api/hcs/topics</code>, then put its id in{" "}
            <code>MARKETPLACE_TOPIC_ID</code>.
          </p>
        </div>
      ) : (
        <>
          <NewListingForm defaultSeller={account} />

          <section className="flex flex-col gap-3">
            <h2 className="font-medium">
              Listings{" "}
              <span className="text-zinc-500">({state!.listings.length})</span>
            </h2>

            {state!.listings.length === 0 && (
              <p className="text-sm text-zinc-500">
                Nothing listed yet. Messages take a few seconds to reach the
                mirror node after submission.
              </p>
            )}

            {state!.listings.map((listing) => (
              <article
                key={listing.id}
                className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div>
                  <p className="font-medium">{listing.title}</p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {formatHbar(listing.priceTinybars)} ℏ · {listing.remaining}{" "}
                    of {listing.quantity} left · seller {listing.seller}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    #{listing.sequenceNumber} · {listing.status}
                  </p>
                </div>
                <BuyButton
                  listingId={listing.id}
                  buyer={account}
                  disabled={listing.status !== "active"}
                />
              </article>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="font-medium">
              Orders{" "}
              <span className="text-zinc-500">({state!.orders.length})</span>
            </h2>
            {state!.orders.map((order) => (
              <p key={order.id} className="text-sm text-zinc-600 dark:text-zinc-400">
                #{order.sequenceNumber} · {order.quantity} ×{" "}
                {order.listingId.slice(0, 8)} · {formatHbar(order.totalTinybars)} ℏ
                · {order.status}
              </p>
            ))}
            {state!.orders.length === 0 && (
              <p className="text-sm text-zinc-500">No orders yet.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
