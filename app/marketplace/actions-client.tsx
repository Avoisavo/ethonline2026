"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const HBAR = 100_000_000;

function useApi() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function call(url: string, body: unknown) {
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Request failed");
      return null;
    }
    startTransition(() => router.refresh());
    return data;
  }

  return { call, pending, error };
}

export function NewListingForm({ defaultSeller }: { defaultSeller: string }) {
  const { call, pending, error } = useApi();
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("1");
  const [quantity, setQuantity] = useState("1");

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await call("/api/marketplace/listings", {
          seller: defaultSeller,
          title,
          priceTinybars: String(Math.round(Number(price) * HBAR)),
          quantity: Number(quantity),
        });
        if (ok) setTitle("");
      }}
    >
      <h2 className="font-medium">List an item</h2>
      <input
        required
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What are you selling?"
        className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Price (HBAR)
          <input
            required
            type="number"
            min="0"
            step="0.00000001"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Quantity
          <input
            required
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {pending ? "Submitting to HCS…" : "Publish listing"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function BuyButton({
  listingId,
  buyer,
  disabled,
}: {
  listingId: string;
  buyer: string;
  disabled: boolean;
}) {
  const { call, pending, error } = useApi();

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        disabled={disabled || pending}
        onClick={() =>
          call("/api/marketplace/orders", { listingId, buyer, quantity: 1 })
        }
        className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
      >
        {pending ? "Ordering…" : "Buy 1"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
