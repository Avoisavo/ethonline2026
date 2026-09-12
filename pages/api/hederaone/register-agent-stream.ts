// pages/api/register-agent-stream.ts — streams the full register flow over SSE:
//   create Hedera account → register its EVM in World AgentBook (emits a `scan` event with the
//   verify link for the UI to render a QR) → poll AgentBook → finish (voting/review/profile/memo/log).
import type { NextApiRequest, NextApiResponse } from "next";
import { getClient, createAgentAccount } from "@/lib/hederaone/hedera";
import { checkAgentHuman } from "@/lib/hederaone/world-agentkit";
import { getAgentBookVerifyLink, pollAgentBook } from "@/lib/hederaone/agentbook";
import { registerAgent, initMars } from "@/lib/hederaone/agents";
import { saveAgent } from "@/lib/hederaone/db.mjs";

export const config = { api: { responseLimit: false }, maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  // SSE heartbeat — Cloudflare's proxied edge drops a connection that's idle for ~100s, but
  // we silently `await pollAgentBook(..., 180_000)` while the human scans the QR. A comment
  // ping every 15s keeps bytes flowing so the stream survives the scan. (Client ignores it:
  // `: ping` fails JSON.parse → caught/continue in pages/hedera.tsx.)
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => clearInterval(heartbeat));

  const client = getClient();
  try {
    const b = req.body ?? {};

    // 1) create the Hedera account → EVM address
    send({ type: "step", step: "account", status: "running", label: "create Hedera account" });
    const acct = await createAgentAccount(client, 1);
    send({ type: "step", step: "account", status: "done", label: "account", id: acct.accountId });

    // 2) register the EVM address in World AgentBook (the UI renders the scan link as a QR)
    let world: { worldVerified: boolean; humanId: string | null } = { worldVerified: false, humanId: null };
    if (process.env.NEXT_PUBLIC_WORLD_APP_ID) {
      send({ type: "step", step: "agentbook", status: "running", label: `register ${acct.evmAddress} in World AgentBook` });
      const existing = await checkAgentHuman(acct.evmAddress).catch(() => null);
      if (existing) {
        world = { worldVerified: true, humanId: existing };
      } else {
        const link = await getAgentBookVerifyLink(acct.evmAddress);
        if (link) {
          send({ type: "scan", link, address: acct.evmAddress });
          const h = await pollAgentBook(acct.evmAddress, { timeoutMs: 180_000 });
          if (h) world = { worldVerified: true, humanId: h };
        }
      }
      send({ type: "step", step: "agentbook", status: "done", label: world.worldVerified ? "registered in AgentBook" : "AgentBook unverified", id: world.humanId ?? undefined });
    }

    // ensure the shared main registry exists (seed once, reuse via mars-state.json)
    let registryTopicId = b.registryTopicId;
    if (!registryTopicId) {
      const m = await initMars(client);
      registryTopicId = m.registryTopicId;
    }

    // 3) finish the Hedera registration (voting/review/profile/memo/main-HCS log) — streams each step
    const role = b.role === "auditor" ? "auditor" : "user";
    const result = await registerAgent(
      client,
      {
        registryTopicId,
        role,
        accountId: acct.accountId,
        accountKey: acct.privateKey,
        evmAddress: acct.evmAddress,
        worldVerified: world.worldVerified,
        humanId: world.humanId,
      },
      (s) => send({ type: "step", ...s })
    );

    // persist to the same store the curl path / dashboard read from
    try {
      saveAgent(role, {
        agent_id: result.account,
        evm_address: result.evmAddress ?? null,
        role,
        world_verified: result.worldVerified,
        human_id: result.humanId ?? null,
        profile_topic: result.profileTopicId,
        voting_topic: result.votingTopicId,
        review_topic: result.reviewTopicId,
        account_memo: result.accountMemo,
        registry_seq: result.registrySeq ?? null,
        encrypted_key: result.encryptedKey ?? null,
        rating: null,
        hedera: true,
        registered_at: new Date().toISOString(),
      });
    } catch {}

    send({ type: "done", result });
  } catch (error: unknown) {
    send({ type: "error", error: error instanceof Error ? error.message : "Unknown error" });
  } finally {
    clearInterval(heartbeat);
    client.close();
    res.end();
  }
}
