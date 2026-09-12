// lib/agents.ts — MARS agent onboarding: account + World agentkit + HCS-11 profile + registry.
// Shared by the /api/hedera route and the scripts/register-agent.ts CLI.
import { Client, PrivateKey, KeyList, AccountUpdateTransaction } from "@hashgraph/sdk";
import {
  createAgentAccount,
  createTopic,
  submitMessage,
  getOperatorKey,
  buildHCS11Profile,
  hcs11AccountMemo,
  buildAgentRegistered,
  hcs2Memo,
  HCS20_MEMO,
  buildHCS20Deploy,
  type AgentRole,
  type NewAccount,
} from "./hedera";
import { checkAgentHuman } from "./world-agentkit";
import { encrypt } from "./encrypt";
import { loadState, saveState } from "./state";

/** World agentkit lookup — soft-fail, never blocks registration. */
async function worldCheck(address?: string): Promise<{ worldVerified: boolean; humanId: string | null }> {
  if (!address) return { worldVerified: false, humanId: null };
  try {
    const h = await checkAgentHuman(address);
    return { worldVerified: h !== null, humanId: h };
  } catch {
    return { worldVerified: false, humanId: null };
  }
}

export interface RegisterAgentOpts {
  registryTopicId: string;
  role?: AgentRole;
  bio?: string;
  capabilities?: number[];
  model?: string;
  initialBalance?: number;
  accountId?: string; // reuse an existing account instead of creating one
  accountKey?: string; // its DER private key (needed to set the account memo + encrypt)
  evmAddress?: string; // its EVM address (for the registry log)
  worldAddress?: string; // address to look up in World AgentBook
  worldVerified?: boolean; // OR a QR proof-of-personhood result (overrides the lookup)
  humanId?: string | null;
}

export interface RegisteredAgent {
  account: string;
  evmAddress?: string;
  role: AgentRole;
  profileTopicId: string;
  votingTopicId: string;
  reviewTopicId: string;
  accountMemo: string;
  registrySeq: string | undefined;
  worldVerified: boolean;
  humanId: string | null;
  encryptedKey?: string;
}

/**
 * Full agent onboarding (users + auditors):
 *   account → World verify → profile topic (1-of-2 key) → HCS-11 profile →
 *   bind topic to the account memo → main-registry log → store key ENCRYPTED.
 */
export type AgentStep = { step: string; status: "running" | "done"; label: string; id?: string };

export async function registerAgent(client: Client, opts: RegisterAgentOpts, onStep?: (s: AgentStep) => void): Promise<RegisteredAgent> {
  const role: AgentRole = opts.role ?? "auditor";
  const emit = (step: string, status: "running" | "done", label: string, id?: string) => onStep?.({ step, status, label, id });

  let account: string;
  let created: NewAccount | null = null;
  let agentKeyDer: string | undefined;
  let evmAddr: string | undefined;
  if (opts.accountId) {
    account = opts.accountId;
    agentKeyDer = opts.accountKey;
    evmAddr = opts.evmAddress;
  } else {
    emit("account", "running", "create Hedera account");
    created = await createAgentAccount(client, opts.initialBalance ?? 5);
    account = created.accountId;
    agentKeyDer = created.privateKey;
    evmAddr = created.evmAddress;
    emit("account", "done", "account", account);
  }

  // World ID: use the caller-provided result (the orchestrator does the AgentBook registration); else look up
  const world =
    opts.worldVerified != null || opts.humanId
      ? { worldVerified: !!opts.worldVerified, humanId: opts.humanId ?? null }
      : await worldCheck(opts.worldAddress ?? created?.evmAddress);

  const operatorKey = getOperatorKey();
  const agentKey = agentKeyDer ? PrivateKey.fromStringDer(agentKeyDer) : null;
  const submitKey = operatorKey.publicKey;
  const profileSubmitKey = agentKey ? new KeyList([agentKey.publicKey, operatorKey.publicKey], 1) : submitKey;

  // the agent's OWN voting HCS (good/bad tickers) + review HCS — both ids get appended to its profile
  emit("voting", "running", "create voting HCS (good/bad)");
  const votingTopicId = await createTopic(client, HCS20_MEMO, submitKey);
  await submitMessage(client, votingTopicId, buildHCS20Deploy("Upvotes", "good", "1000000", "1000"));
  await submitMessage(client, votingTopicId, buildHCS20Deploy("Downvotes", "bad", "1000000", "1000"));
  emit("voting", "done", "voting HCS", votingTopicId);

  emit("review", "running", "create review HCS");
  const reviewTopicId = await createTopic(client, "mars-reviews", submitKey);
  await submitMessage(client, reviewTopicId, JSON.stringify({ p: "mars-review", op: "seed", note: `reviews for ${account}`, timestamp: new Date().toISOString() }));
  emit("review", "done", "review HCS", reviewTopicId);

  // profile topic — 1-of-2 submit key (agent OR operator) when we hold the agent key; carries the 2 record ids
  emit("profile", "running", "create profile HCS (HCS-11)");
  const profileTopicId = await createTopic(client, `hcs-11:profile:${account}`, profileSubmitKey);
  await submitMessage(
    client,
    profileTopicId,
    buildHCS11Profile(role, account, opts.capabilities ?? [1, 2, 11, 16, 18, 20], opts.model ?? "mars-v1", {
      bio: opts.bio,
      creator: "MARS",
      properties: { worldVerified: world.worldVerified, ...(world.humanId && { humanId: world.humanId }), votingTopicId, reviewTopicId },
    })
  );
  emit("profile", "done", "profile HCS", profileTopicId);

  // bind the topic back to the account: set its HCS-11 memo (signed by the agent's own key)
  const accountMemo = hcs11AccountMemo(profileTopicId);
  if (agentKey) {
    emit("memo", "running", "bind profile → account memo");
    await (
      await (await new AccountUpdateTransaction().setAccountId(account).setAccountMemo(accountMemo).freezeWith(client).sign(agentKey)).execute(client)
    ).getReceipt(client);
    emit("memo", "done", "account memo set");
  }

  emit("registry", "running", "log agent_registered → main HCS");
  const reg = await submitMessage(
    client,
    opts.registryTopicId,
    buildAgentRegistered({ account, role, profileTopicId, votingTopicId, reviewTopicId, evmAddress: evmAddr, worldVerified: world.worldVerified, humanId: world.humanId })
  );
  emit("registry", "done", "agent_registered", reg.sequenceNumber);

  return {
    account,
    evmAddress: evmAddr,
    role,
    profileTopicId,
    votingTopicId,
    reviewTopicId,
    accountMemo,
    registrySeq: reg.sequenceNumber,
    worldVerified: world.worldVerified,
    humanId: world.humanId,
    encryptedKey: agentKeyDer ? encrypt(agentKeyDer) : undefined,
  };
}

/** Ensure the seeded MAIN registry (the shared history HCS) exists. Voting + review topics are
 *  created PER AGENT in registerAgent, not here. Seeds once to mars-state.json and reuses it. */
export async function initMars(
  client: Client,
  opts: { force?: boolean } = {}
): Promise<{ registryTopicId: string; seeded: boolean }> {
  const state = loadState();
  if (!opts.force && state.registryTopicId) {
    return { registryTopicId: state.registryTopicId, seeded: true };
  }
  const registryTopicId = await createTopic(client, hcs2Memo(), getOperatorKey().publicKey);
  saveState({ registryTopicId });
  return { registryTopicId, seeded: false };
}
