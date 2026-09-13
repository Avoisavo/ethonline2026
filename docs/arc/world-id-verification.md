# World ID verification (reference only)

This is **not Arc code**. It is the World ID ("verify you're human") gate that ethnyc's
`/publish` page showed as step 1 before an author could publish a skill. It came along with the
Arc port only because that page imported it, so it's kept here as reference and is **not** wired
into this project. `/arc/publish` now skips straight to publishing and sends `author.humanId: null`.

## How it worked

1. `WorldIdVerification` (client component) calls `POST /api/rp-signature` with the World ID `action`.
2. `rp-signature` signs the request with `RP_SIGNING_KEY` via `@worldcoin/idkit-core/signing`.
3. The component opens an IDKit request (`IDKit`, `orbLegacy` from `@worldcoin/idkit-core`) and shows a
   QR code (`qrcode.react`) for World App.
4. The IDKit result is sent to `POST /api/verify-proof`, which forwards it to
   `https://developer.world.org/api/v4/verify/<NEXT_PUBLIC_RP_ID>`.
5. On success the page gets `verified = true` and the proof's `onchain.nullifier` (stored as the author's `humanId`).

Props as used by the publish page:
`<WorldIdVerification verified setVerified setStatus appId={NEXT_PUBLIC_WORLD_APP_ID} rpId={NEXT_PUBLIC_RP_ID} onVerified={(d) => d?.onchain?.nullifier} />`

Env it needed: `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_RP_ID`, `RP_SIGNING_KEY`
(this project's `.env.local` uses the names `WORLD_APP_ID` / `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY` instead).
npm deps: `@worldcoin/idkit-core`, `qrcode.react`.

To re-enable it: copy the three files below back into `components/` and `pages/api/`, install
`@worldcoin/idkit-core`, and restore the step-1 section in `pages/arc/publish.tsx`.

Source: https://github.com/derek2403/ethnyc (original paths shown).

## components/WorldIdVerification.tsx

```tsx
import { useState } from "react";
import { IDKit, orbLegacy } from "@worldcoin/idkit-core";
import type { IDKitCompletionResult } from "@worldcoin/idkit-core";
import { QRCodeSVG } from "qrcode.react";

interface WorldIdVerificationProps {
  verified: boolean;
  setVerified: (v: boolean) => void;
  setStatus: (s: string) => void;
  appId: `app_${string}`;
  rpId: string;
  onVerified?: (data: { success: boolean; onchain?: { nullifier?: string } | null }) => void;
}

export default function WorldIdVerification({
  verified,
  setVerified,
  setStatus,
  appId,
  rpId,
  onVerified,
}: WorldIdVerificationProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  const handleVerify = async () => {
    try {
      setStatus("Getting RP signature...");
      const rpSig = await fetch("/api/rp-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify-human" }),
      }).then((r) => r.json());

      if (rpSig.error) {
        setStatus(`RP signature error: ${rpSig.error}`);
        return;
      }

      setStatus("Creating verification request...");
      const request = await IDKit.request({
        app_id: appId,
        action: "verify-human",
        rp_context: {
          rp_id: rpId,
          nonce: rpSig.nonce,
          created_at: rpSig.created_at,
          expires_at: rpSig.expires_at,
          signature: rpSig.sig,
        },
        allow_legacy_proofs: true,
        environment: "production",
      }).preset(orbLegacy());

      if (request.connectorURI) {
        setQrUrl(request.connectorURI);
        setStatus("Scan the QR code with World App");
      } else {
        setStatus("Waiting for World App confirmation...");
      }

      const completion: IDKitCompletionResult =
        await request.pollUntilCompletion();

      setQrUrl(null);

      if (!completion.success) {
        const failed = completion as { success: false; error: string };
        setStatus(`Verification failed: ${failed.error}`);
        return;
      }

      setStatus("Verifying proof on server...");
      const verifyRes = await fetch("/api/verify-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idkitResponse: completion.result }),
      });

      const text = await verifyRes.text();
      let verifyData;
      try {
        verifyData = JSON.parse(text);
      } catch {
        setStatus(`Server error: ${text.slice(0, 200)}`);
        return;
      }

      if (verifyData.success) {
        setVerified(true);
        setStatus("");
        onVerified?.(verifyData);
      } else {
        setStatus(verifyData.error ?? "Proof verification failed");
      }
    } catch (err) {
      setQrUrl(null);
      setStatus(
        `Verify error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return (
    <div className="w-full rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        Step 1
      </p>
      <p className="mb-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Verify you are human
      </p>

      {verified ? (
        <div className="flex items-center justify-between rounded-xl bg-green-50 px-4 py-3 dark:bg-green-900/20">
          <span className="text-sm text-green-700 dark:text-green-400">
            World ID Verified
          </span>
          <span className="text-xs text-green-600 dark:text-green-500">
            &#10003;
          </span>
        </div>
      ) : (
        <>
          <button
            onClick={handleVerify}
            className="w-full rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Verify with World ID
          </button>
          {qrUrl && (
            <div className="mt-4 flex flex-col items-center gap-3">
              <QRCodeSVG value={qrUrl} size={200} />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Scan with World App
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

## pages/api/rp-signature.ts

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { signRequest } from "@worldcoin/idkit-core/signing";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body;

  if (!action) {
    return res.status(400).json({ error: "Missing action" });
  }

  const signingKey = process.env.RP_SIGNING_KEY;
  if (!signingKey) {
    return res.status(500).json({ error: "RP_SIGNING_KEY not configured" });
  }

  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: signingKey,
    action,
  });

  return res.status(200).json({
    sig,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
  });
}
```

## pages/api/verify-proof.ts

```ts
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rpId = process.env.NEXT_PUBLIC_RP_ID;
  if (!rpId) {
    return res.status(500).json({ error: "RP_ID not configured" });
  }

  const { idkitResponse } = req.body;
  if (!idkitResponse) {
    return res.status(400).json({ error: "Missing idkitResponse" });
  }

  // Forward the IDKit v4 result payload as-is to the World ID cloud API
  const response = await fetch(
    `https://developer.world.org/api/v4/verify/${rpId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResponse),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    return res.status(400).json({
      error: errorData.detail ?? `Verification failed (${response.status})`,
    });
  }

  // Cloud verification passed. Return the v4 proof data so the frontend can,
  // if needed, submit it on-chain to a WorldIDVerifier.verify() contract.
  const firstResponse = idkitResponse.responses?.[0];

  return res.status(200).json({
    success: true,
    // On-chain verification params (v4 format)
    onchain: firstResponse
      ? {
          nullifier: firstResponse.nullifier,
          proof: firstResponse.proof, // uint256[5]
          signal_hash: firstResponse.signal_hash,
          expires_at_min: firstResponse.expires_at_min,
          issuer_schema_id: firstResponse.issuer_schema_id,
          nonce: idkitResponse.nonce,
        }
      : null,
  });
}
```
