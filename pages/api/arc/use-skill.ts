import type { NextApiRequest, NextApiResponse } from "next";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { loadState } from "@/lib/hederaone/state";
import { getAgentKey, SKILL_SELLER, PRICE_DISPLAY } from "@/lib/arc/x402";
import { getClient, mintNft, transferNft } from "@/lib/hederaone/hedera";

// ethonlineArc — USE a verified skill, gated by the VERIFIED NFT (the license).
//
// The VERIFIED HTS NFT (token loadState().verifiedTokenId, metadata {skill, verdict, task}) is the
// LICENSE to use a skill. On a request:
//   • account HOLDS the NFT for this skill → access GRANTED, no payment (already licensed)
//   • account does NOT hold it            → 402: pay 0.01 USDC via x402 nanopayment (Circle Gateway,
//                                           gas-free). With &pay=1 we settle the nanopayment AND
//                                           mint a fresh VERIFIED NFT to that account → now licensed.
//   • skill was never verified            → 404 (nothing to license)
//
//   curl "http://localhost:3000/api/arc/use-skill?skill=safe-weather-skill&account=0.0.9227937"      # holder → free
//   curl "http://localhost:3000/api/arc/use-skill?skill=safe-weather-skill&account=0.0.9227928"      # non-holder → 402
//   curl "http://localhost:3000/api/arc/use-skill?skill=safe-weather-skill&account=0.0.9227928&pay=1"# pay (gw nanopayment) → mint NFT → granted
//
// Two chains: the license/NFT lives on HEDERA (HTS), the payment on ARC (x402 / Circle Gateway).
// For the demo the SERVER's agent wallet pays the seller; in production the user's wallet would.
export const config = { maxDuration: 60 };

const MIRROR = "https://testnet.mirrornode.hedera.com";

/** Tolerant skill-name match (case + the "-vN" version suffix / 22-char metadata truncation). */
function skillMatch(want: string, have: string): boolean {
  if (!have) return false;
  const norm = (s: string) => s.toLowerCase().replace(/-v\d+$/, "").trim();
  const a = norm(want), b = norm(have);
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q: Record<string, unknown> = req.method === "POST" ? { ...req.query, ...(req.body ?? {}) } : req.query;
  const skill = String(q.skill ?? q.name ?? "").trim();
  const account = String(q.account ?? q.agent_id ?? q.agentId ?? "").trim();
  const pay = q.pay === "1" || q.pay === true || q.pay === "true";
  if (!skill || !account) return res.status(400).json({ error: "provide ?skill=<name>&account=<0.0.x>" });

  const tokenId = loadState().verifiedTokenId;
  if (!tokenId) return res.status(500).json({ error: "no VERIFIED token configured — run an audit first" });

  // 1) Scan the VERIFIED collection: which serials are for THIS skill, and who owns each?
  let matches: { serial: number; owner: string; verdict?: string }[] = [];
  try {
    const data = await fetch(`${MIRROR}/api/v1/tokens/${tokenId}/nfts?limit=200`).then((r) => r.json());
    matches = ((data?.nfts ?? []) as { serial_number: number; account_id: string; metadata: string }[])
      .map((n) => {
        let meta: { skill?: string; verdict?: string } = {};
        try { meta = JSON.parse(Buffer.from(n.metadata, "base64").toString("utf8")); } catch { /* not JSON */ }
        return { serial: n.serial_number, owner: n.account_id, skill: meta.skill ?? "", verdict: meta.verdict };
      })
      .filter((n) => skillMatch(skill, n.skill));
  } catch (e: unknown) {
    return res.status(502).json({ error: `Mirror Node lookup failed: ${e instanceof Error ? e.message : "unknown"}` });
  }

  // No serial for this skill → it was never verified → nothing to license.
  if (!matches.length) {
    return res.status(404).json({ error: `"${skill}" is not verified — no VERIFIED NFT exists for it`, token: tokenId });
  }

  // 2) Account already HOLDS a serial for this skill → access granted, NO payment.
  const held = matches.find((m) => m.owner === account);
  if (held) {
    return res.status(200).json({
      access: "granted", paid: false, skill, account,
      reason: "holds the VERIFIED NFT — already licensed",
      nft: `${tokenId}#${held.serial}`, verdict: held.verdict,
    });
  }

  // 3) Does NOT hold it → payment required. Without &pay=1, return a 402 with the terms.
  if (!pay) {
    return res.status(402).json({
      access: "payment_required", paid: false, skill, account,
      reason: "does not hold the VERIFIED NFT — pay to use",
      price: `${PRICE_DISPLAY} USDC`, pay_via: "x402 nanopayment (Circle Gateway, gas-free)",
      pay_to: SKILL_SELLER, nft_collection: tokenId,
      hint: "re-run with &pay=1 to pay via x402 and get the VERIFIED NFT minted to you",
    });
  }

  // 4) &pay=1 → (a) pay 0.01 USDC via the x402 / Circle Gateway nanopayment, then (b) MINT a fresh
  //    VERIFIED NFT for this skill to the account (so it's licensed from now on).
  let payment: { amount: string; settlement_tx: string; payer: string; seller: string };
  let verifiedLink: string | undefined;
  try {
    const proto = (req.headers["x-forwarded-proto"] as string) || "http";
    const base = `${proto}://${req.headers.host}`;
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: getAgentKey() });
    const bal = await client.getBalances();
    if (bal.gateway.available < 10_000n) await client.deposit("1"); // top up the Gateway balance once
    const result = await client.pay(`${base}/api/arc/skill?payTo=${SKILL_SELLER}`); // gw nanopayment
    payment = { amount: result.formattedAmount, settlement_tx: result.transaction, payer: client.address, seller: SKILL_SELLER };
    verifiedLink = (result.data as { verifiedLink?: string })?.verifiedLink;
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string };
    return res.status(500).json({ error: err.shortMessage || err.message || "x402 payment failed" });
  }

  // (b) Mint + deliver the VERIFIED NFT to the buyer (best-effort transfer — needs the account to be
  //     token-associated; otherwise it's minted to the treasury and can be claimed later).
  const verdict = matches[0]?.verdict ?? "SAFE";
  const metaFull = JSON.stringify({ skill, verdict, via: "x402", to: account });
  const metadata = Buffer.byteLength(metaFull, "utf-8") <= 100 ? metaFull : JSON.stringify({ skill: skill.slice(0, 24), via: "x402", to: account });
  const hedera = getClient();
  try {
    const mint = await mintNft(hedera, tokenId, metadata);
    let delivered = false;
    let transferNote: string | undefined;
    try {
      await transferNft(hedera, tokenId, Number(mint.serial), account);
      delivered = true;
    } catch (e: unknown) {
      transferNote = `minted to treasury — transfer failed (associate ${tokenId} on ${account}): ${e instanceof Error ? e.message : "error"}`;
    }
    return res.status(200).json({
      access: "granted", paid: true, skill, account,
      reason: "no VERIFIED NFT — paid via x402, NFT minted",
      payment, verified_link: verifiedLink,
      nft: `${tokenId}#${mint.serial}`, nft_owner: delivered ? account : "treasury (pending association)",
      ...(transferNote && { note: transferNote }),
    });
  } finally {
    hedera.close();
  }
}
