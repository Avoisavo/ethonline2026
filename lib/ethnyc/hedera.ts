// ════════════════════════════════════════════════════════════════════════════
// MARS — consolidated Hedera module (Hedera TESTNET)
// ----------------------------------------------------------------------------
// One BANNER-block per concern. To trim: delete a whole block (and its actions
// in pages/api/hedera.ts). Hand-rolled JSON envelopes + Mirror Node reads,
// modeled on DIVE (cannes2026) + SPARK. Single-operator ("operator pays") model.
//
// Standards covered (README §5):
//   HTS  → VERIFIED NFT + version-bound LICENSE NFT (royalty fee deferred for now)
//   HCS-1  file storage (audit reports / SKILL.json manifests)
//   HCS-2  topic registry (main registry → per-skill subtopics)
//   HCS-26 skills registry  (NEW — discovery + per-skill version registries)
//   HCS-25 AI trust score   (NEW — methodology, MARS picks the carrier)
//   HCS-18 RFQ / discovery board (auditors announce + quote)
//   HCS-16 Flora comms room (negotiation; communication, NOT voting)
//   HCS-11 agent profile      +  HCS-14 universal agent id (uaid)
//   HCS-20 reputation points / reviews
//   Scheduled tx → re-audit on update
//   + MARS audit-trail messages (per-test live HCS log)
// ════════════════════════════════════════════════════════════════════════════

import {
  Client,
  PrivateKey,
  Hbar,
  AccountCreateTransaction,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenAssociateTransaction,
  TokenType,
  TokenSupplyType,
  TokenId,
  NftId,
  TransferTransaction,
  ScheduleCreateTransaction,
  CustomRoyaltyFee,
  CustomFixedFee,
  AccountId,
} from "@hashgraph/sdk";
import type { Key } from "@hashgraph/sdk";
import { createHash } from "crypto";
import { brotliCompressSync, brotliDecompressSync } from "zlib";

// ════════════════════════════════════════════════════════════════════════════
// CONFIG & CLIENT
// ════════════════════════════════════════════════════════════════════════════

const MIRROR_URL =
  process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com";

/** Testnet client authenticated with the operator (pays for everything). */
export function getClient(): Client {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error(
      "Missing HEDERA_OPERATOR_ID or HEDERA_OPERATOR_KEY in environment variables"
    );
  }
  return Client.forTestnet().setOperator(operatorId, operatorKey);
}

export function getOperatorId(): string {
  const id = process.env.HEDERA_OPERATOR_ID;
  if (!id) throw new Error("Missing HEDERA_OPERATOR_ID");
  return id;
}

/** Operator private key (DER-encoded in env). Used as admin/supply/submit key. */
export function getOperatorKey(): PrivateKey {
  const key = process.env.HEDERA_OPERATOR_KEY;
  if (!key) throw new Error("Missing HEDERA_OPERATOR_KEY");
  return PrivateKey.fromStringDer(key);
}

export function hashscan(
  kind: "token" | "topic" | "account" | "transaction",
  id: string
): string {
  return `https://hashscan.io/testnet/${kind}/${id}`;
}

// ════════════════════════════════════════════════════════════════════════════
// MIRROR NODE READER  — all on-chain reads go through the mirror node (no SDK query)
// ════════════════════════════════════════════════════════════════════════════

export interface MirrorMessage extends Record<string, unknown> {
  _seq: number;
  _timestamp: string;
  _payer: string;
}

interface RawMirrorMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
}

/** Read a topic's messages, base64-decode + JSON.parse each, attach _seq/_timestamp/_payer. Never throws on bad JSON. */
export async function readTopicMessages(
  topicId: string,
  limit = 100
): Promise<MirrorMessage[]> {
  const res = await fetch(
    `${MIRROR_URL}/api/v1/topics/${topicId}/messages?limit=${limit}&order=asc`
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: RawMirrorMessage[] };
  return (data.messages || []).map((msg) => {
    const base = {
      _seq: msg.sequence_number,
      _timestamp: msg.consensus_timestamp,
      _payer: msg.payer_account_id,
    };
    const raw = Buffer.from(msg.message, "base64").toString("utf-8");
    try {
      return { ...(JSON.parse(raw) as Record<string, unknown>), ...base };
    } catch {
      return { _raw: raw, ...base };
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TOPIC HELPERS
// ════════════════════════════════════════════════════════════════════════════

export async function createTopic(
  client: Client,
  memo: string,
  submitKey?: Key,
  adminKey?: Key
): Promise<string> {
  const tx = new TopicCreateTransaction().setTopicMemo(memo);
  if (submitKey) tx.setSubmitKey(submitKey);
  if (adminKey) tx.setAdminKey(adminKey);
  const receipt = await (await tx.execute(client)).getReceipt(client);
  return receipt.topicId!.toString();
}

export async function submitMessage(
  client: Client,
  topicId: string,
  message: string
): Promise<{ status: string; sequenceNumber: string | undefined }> {
  const receipt = await (
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(message)
      .execute(client)
  ).getReceipt(client);
  return {
    status: receipt.status.toString(),
    sequenceNumber: receipt.topicSequenceNumber?.toString(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTS  — one Hedera account per agent (auditor / author / user)
// ════════════════════════════════════════════════════════════════════════════

export interface NewAccount {
  accountId: string;
  publicKey: string;
  privateKey: string; // DER. DEMO ONLY — never return raw keys in production.
  evmAddress: string;
  initialBalance: number;
}

/** Create a fresh ECDSA-keyed agent account (ECDSA → real EVM address for Arc/World/Chainlink). */
export async function createAgentAccount(
  client: Client,
  initialBalanceHbar = 5
): Promise<NewAccount> {
  const key = PrivateKey.generateECDSA();
  const receipt = await (
    await new AccountCreateTransaction()
      .setKey(key.publicKey)
      .setInitialBalance(new Hbar(initialBalanceHbar))
      .setMaxAutomaticTokenAssociations(-1) // -1 = unlimited auto-assoc (skip associate step)
      .execute(client)
  ).getReceipt(client);
  return {
    accountId: receipt.accountId!.toString(),
    publicKey: key.publicKey.toStringDer(),
    privateKey: key.toStringDer(),
    evmAddress: `0x${key.publicKey.toEvmAddress()}`,
    initialBalance: initialBalanceHbar,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// HTS — VERIFIED NFT  +  version-bound LICENSE NFT (with author CustomRoyaltyFee)
// Each NFT is unique + ownable; metadata is a COMPACT pointer (≤100 bytes), so the
// full manifest/report lives on HCS-1 and the NFT carries its HRL (hcs://1/<id>).
// ════════════════════════════════════════════════════════════════════════════

export interface NftCollection {
  tokenId: string;
  name: string;
  symbol: string;
}

/** VERIFIED-badge NFT collection (one serial minted per skill that passes). */
export async function createVerifiedCollection(
  client: Client,
  name = "MARS Verified",
  symbol = "MARSV"
): Promise<NftCollection> {
  const operatorKey = getOperatorKey();
  const tx = await new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setInitialSupply(0)
    .setDecimals(0)
    .setTreasuryAccountId(getOperatorId())
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .setMaxTransactionFee(new Hbar(40))
    .freezeWith(client);
  const receipt = await (
    await (await tx.sign(operatorKey)).execute(client)
  ).getReceipt(client);
  return { tokenId: receipt.tokenId!.toString(), name, symbol };
}

export interface LicenseCollectionOptions {
  name?: string;
  symbol?: string;
  /** Author payout account (0.0.x) — when set, a real author royalty is attached. */
  royaltyCollectorAccountId?: string;
  /** Royalty fraction = numerator/denominator of each license SALE value (e.g. 10/100 = 10%). */
  numerator?: number;
  denominator?: number;
  /** Fallback fixed fee (in HBAR) charged when a transfer carries no fungible value. */
  fallbackHbar?: number;
}

/** Version-bound LICENSE NFT collection.
 *  When `royaltyCollectorAccountId` is given, a real Hedera `CustomRoyaltyFee` is
 *  attached at create-time: every license SALE auto-routes `numerator/denominator`
 *  of the proceeds to the author (with an HBAR fallback fee for value-less
 *  transfers), implementing README §4 (author royalty). Omit it for a plain license. */
export async function createLicenseCollection(
  client: Client,
  opts: LicenseCollectionOptions = {}
): Promise<NftCollection & { royalty?: { collector: string; numerator: number; denominator: number; fallbackHbar: number } }> {
  const operatorKey = getOperatorKey();
  const { name = "MARS License", symbol = "MARSL" } = opts;

  const tx = new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setInitialSupply(0)
    .setDecimals(0)
    .setTreasuryAccountId(getOperatorId())
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .setMaxTransactionFee(new Hbar(50));

  // ── author royalty (the deferred feature) ────────────────────────────────
  let royalty: { collector: string; numerator: number; denominator: number; fallbackHbar: number } | undefined;
  if (opts.royaltyCollectorAccountId) {
    const numerator = Math.max(1, Math.round(opts.numerator ?? 10));
    const denominator = Math.max(numerator, Math.round(opts.denominator ?? 100));
    const fallbackHbar = opts.fallbackHbar ?? 1;
    const fee = new CustomRoyaltyFee()
      .setNumerator(numerator)
      .setDenominator(denominator)
      .setFeeCollectorAccountId(AccountId.fromString(opts.royaltyCollectorAccountId))
      .setFallbackFee(new CustomFixedFee().setHbarAmount(new Hbar(fallbackHbar)));
    tx.setCustomFees([fee]).setFeeScheduleKey(operatorKey.publicKey);
    royalty = { collector: opts.royaltyCollectorAccountId, numerator, denominator, fallbackHbar };
  }

  const frozen = await tx.freezeWith(client);
  const receipt = await (
    await (await frozen.sign(operatorKey)).execute(client)
  ).getReceipt(client);
  return { tokenId: receipt.tokenId!.toString(), name, symbol, ...(royalty && { royalty }) };
}

/** Mint one NFT serial. `metadata` MUST be ≤100 bytes — use an HRL (hcs://1/<id>) or compact ref. */
export async function mintNft(
  client: Client,
  tokenId: string,
  metadata: string
): Promise<{ tokenId: string; serial: string }> {
  const operatorKey = getOperatorKey();
  const bytes = Buffer.from(metadata, "utf-8");
  if (bytes.length > 100) {
    throw new Error(
      `NFT metadata is ${bytes.length} bytes; HTS limit is 100. Store the full manifest on HCS-1 and put its HRL (hcs://1/<topicId>) here.`
    );
  }
  const tx = await new TokenMintTransaction()
    .setTokenId(tokenId)
    .addMetadata(bytes)
    .setMaxTransactionFee(new Hbar(20))
    .freezeWith(client);
  const receipt = await (
    await (await tx.sign(operatorKey)).execute(client)
  ).getReceipt(client);
  return { tokenId, serial: receipt.serials[0]?.toString() ?? "" };
}

/** Associate a token to an account (only needed if the account is NOT auto-assoc). Account must sign. */
export async function associateToken(
  client: Client,
  tokenId: string,
  accountId: string,
  accountKey: PrivateKey
): Promise<{ status: string }> {
  const tx = await new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds([tokenId])
    .setMaxTransactionFee(new Hbar(5))
    .freezeWith(client);
  try {
    const receipt = await (
      await (await tx.sign(accountKey)).execute(client)
    ).getReceipt(client);
    return { status: receipt.status.toString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("TOKEN_ALREADY_ASSOCIATED")) return { status: "ALREADY_ASSOCIATED" };
    throw e;
  }
}

/** Deliver a LICENSE NFT serial from the operator treasury to a buyer. */
export async function transferNft(
  client: Client,
  tokenId: string,
  serial: number,
  toAccountId: string
): Promise<{ status: string }> {
  const operatorKey = getOperatorKey();
  const nftId = new NftId(TokenId.fromString(tokenId), serial);
  const tx = await new TransferTransaction()
    .addNftTransfer(nftId, getOperatorId(), toAccountId)
    .setMaxTransactionFee(new Hbar(20))
    .freezeWith(client);
  const receipt = await (
    await (await tx.sign(operatorKey)).execute(client)
  ).getReceipt(client);
  return { status: receipt.status.toString() };
}

interface RawNft {
  serial_number: number;
  account_id?: string;
  metadata?: string; // base64
  deleted?: boolean;
}

export interface NftRecord {
  serial: string;
  owner: string;
  metadata: string; // decoded
  skill?: string; // parsed from metadata JSON
  version?: string;
}

/** Look up a collection's minted NFTs (serial, owner, decoded metadata → skill/version).
 *  Filter by serial / owner account / version to answer "is the NFT for this version held, and by whom?" */
export async function checkNft(
  tokenId: string,
  opts: { serial?: number; account?: string; version?: string } = {}
): Promise<{ found: boolean; count: number; nfts: NftRecord[] }> {
  const url =
    opts.serial != null
      ? `${MIRROR_URL}/api/v1/tokens/${tokenId}/nfts/${opts.serial}`
      : `${MIRROR_URL}/api/v1/tokens/${tokenId}/nfts?limit=100`;
  const res = await fetch(url);
  if (!res.ok) return { found: false, count: 0, nfts: [] };
  const data = (await res.json()) as { nfts?: RawNft[] } & RawNft;
  const raw: RawNft[] = opts.serial != null ? [data] : data.nfts ?? [];
  let nfts: NftRecord[] = raw
    .filter((n) => n && !n.deleted)
    .map((n) => {
      const metadata = n.metadata ? Buffer.from(n.metadata, "base64").toString("utf-8") : "";
      let skill: string | undefined;
      let version: string | undefined;
      try {
        const j = JSON.parse(metadata) as { skill?: string; version?: string };
        skill = j.skill;
        version = j.version;
      } catch {
        /* metadata is not JSON (e.g. a bare HRL) */
      }
      return { serial: String(n.serial_number), owner: n.account_id ?? "", metadata, skill, version };
    });
  if (opts.account) nfts = nfts.filter((n) => n.owner === opts.account);
  if (opts.version) nfts = nfts.filter((n) => n.version === opts.version || n.metadata.includes(opts.version as string));
  return { found: nfts.length > 0, count: nfts.length, nfts };
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-1 — FILE STORAGE (audit reports / SKILL.json manifests)
// Topic = one file. memo `<sha256>:brotli:base64`. Submit key REQUIRED, admin key
// FORBIDDEN (→ immutable, content-addressed). Chunks = {o, c}; o=0 carries the
// data-URI prefix. Compression is spec-mandated (brotli via Node zlib, no dep).
// ════════════════════════════════════════════════════════════════════════════

// base64 chars per chunk; headroom under the 1024-byte HCS message limit for the {"o":N,"c":"..."} wrapper
const HCS1_CHUNK_SIZE = 800;

export interface Hcs1File {
  topicId: string;
  hrl: string; // hcs://1/<topicId>
  contentHash: string; // sha256 of the ORIGINAL (uncompressed) bytes
  chunks: number;
  algo: "brotli";
}

export async function uploadFileHCS1(
  client: Client,
  content: string | Buffer,
  mimeType = "application/json"
): Promise<Hcs1File> {
  const operatorKey = getOperatorKey();
  const original = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  const contentHash = createHash("sha256").update(original).digest("hex");

  const b64 = brotliCompressSync(original).toString("base64");
  const dataUri = `data:${mimeType};base64,${b64}`; // o=0 chunk includes this prefix

  // submit key set, NO admin key → valid, immutable HCS-1 topic
  const topicId = await createTopic(client, `${contentHash}:brotli:base64`, operatorKey.publicKey);

  let chunks = 0;
  for (let i = 0; i < dataUri.length; i += HCS1_CHUNK_SIZE) {
    await submitMessage(
      client,
      topicId,
      JSON.stringify({ o: chunks, c: dataUri.slice(i, i + HCS1_CHUNK_SIZE) })
    );
    chunks++;
  }
  return { topicId, hrl: `hcs://1/${topicId}`, contentHash, chunks, algo: "brotli" };
}

export async function downloadFileHCS1(
  topicId: string
): Promise<{ content: string; contentHash: string; verified: boolean }> {
  const messages = await readTopicMessages(topicId, 1000);
  const dataUri = messages
    .filter((m) => typeof m.o === "number" && typeof m.c === "string")
    .sort((a, b) => (a.o as number) - (b.o as number))
    .map((m) => m.c as string)
    .join("");
  const b64 = dataUri.replace(/^data:[^;]+;base64,/, "");
  const original = brotliDecompressSync(Buffer.from(b64, "base64"));
  const contentHash = createHash("sha256").update(original).digest("hex");

  let verified = false;
  try {
    const info = (await (await fetch(`${MIRROR_URL}/api/v1/topics/${topicId}`)).json()) as {
      memo?: string;
    };
    verified = (info.memo || "").split(":")[0] === contentHash;
  } catch {
    /* mirror lag — leave verified=false */
  }
  return { content: original.toString("utf-8"), contentHash, verified };
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-2 — TOPIC REGISTRY (main registry → per-skill subtopics)
// memo `hcs-2:<indexed>:<ttl>`. `metadata` = HRL pointer; `m` = human memo.
// ════════════════════════════════════════════════════════════════════════════

export const hcs2Memo = (indexed = 0, ttl = 86400) => `hcs-2:${indexed}:${ttl}`;

export function buildHCS2Register(t_id: string, metadata?: string, m?: string): string {
  return JSON.stringify({ p: "hcs-2", op: "register", t_id, ...(metadata && { metadata }), ...(m && { m }) });
}
export function buildHCS2Update(uid: string, t_id: string, metadata?: string, m?: string): string {
  return JSON.stringify({ p: "hcs-2", op: "update", uid, t_id, ...(metadata && { metadata }), ...(m && { m }) });
}
export function buildHCS2Delete(uid: string, m?: string): string {
  return JSON.stringify({ p: "hcs-2", op: "delete", uid, ...(m && { m }) });
}

export interface HCS2Entry {
  uid: string;
  t_id: string;
  metadata?: string;
  m?: string;
}
/** Replay an indexed registry topic → current (non-deleted) entries. uid = register's sequence number. */
export function computeHCS2State(messages: MirrorMessage[]): HCS2Entry[] {
  const entries: Record<string, { t_id: string; metadata?: string; m?: string; deleted: boolean }> = {};
  for (const msg of messages) {
    if (msg.p !== "hcs-2") continue;
    if (msg.op === "register") {
      entries[String(msg._seq)] = {
        t_id: msg.t_id as string,
        metadata: msg.metadata as string | undefined,
        m: msg.m as string | undefined,
        deleted: false,
      };
    } else if (msg.op === "update") {
      const uid = msg.uid as string;
      if (entries[uid] && !entries[uid].deleted) {
        entries[uid] = {
          t_id: msg.t_id as string,
          metadata: msg.metadata as string | undefined,
          m: msg.m as string | undefined,
          deleted: false,
        };
      }
    } else if (msg.op === "delete") {
      const uid = msg.uid as string;
      if (entries[uid]) entries[uid].deleted = true;
    }
  }
  return Object.entries(entries)
    .filter(([, v]) => !v.deleted)
    .map(([uid, v]) => ({ uid, t_id: v.t_id, metadata: v.metadata, m: v.m }));
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-26 — SKILLS REGISTRY (NEW)   (built on HCS-2 + HCS-1)
// Discovery registry (type 0): one global topic; each `register` creates a skill
//   whose consensus SEQUENCE NUMBER becomes the skill_uid (NOT in the payload).
// Version registry (type 1): one topic PER skill; each `register` is a release.
// Each version's t_id → an HCS-1 topic holding the SKILL.json manifest.
// ════════════════════════════════════════════════════════════════════════════

export const hcs26DiscoveryMemo = (indexed = 0, ttl = 86400) => `hcs-26:${indexed}:${ttl}:0`;
export const hcs26VersionMemo = (indexed = 0, ttl = 86400) => `hcs-26:${indexed}:${ttl}:1`;
export const hcs26ReputationMemo = (indexed = 0, ttl = 86400) => `hcs-26:${indexed}:${ttl}:2`;

export interface SkillMetadata {
  name: string;
  description: string;
  author: string;
  license?: string;
  tags?: number[]; // OASF numeric ids
  languages?: string[];
  homepage?: string;
  repo?: string;
  commit?: string;
}

// --- Discovery registry ops (t_id → this skill's version-registry topic) ---
export function buildHCS26SkillRegister(versionRegistryTopicId: string, accountId: string, metadata: SkillMetadata, m?: string): string {
  return JSON.stringify({ p: "hcs-26", op: "register", t_id: versionRegistryTopicId, account_id: accountId, metadata, ...(m && { m }) });
}
export function buildHCS26SkillUpdate(uid: string, accountId: string, metadata: Partial<SkillMetadata>, m?: string): string {
  return JSON.stringify({ p: "hcs-26", op: "update", uid, account_id: accountId, metadata, ...(m && { m }) });
}
export function buildHCS26SkillDelete(uid: string, m?: string): string {
  return JSON.stringify({ p: "hcs-26", op: "delete", uid, ...(m && { m }) });
}

// --- Version registry ops (t_id → HCS-1 SKILL.json manifest) ---
export type SkillStatus = "active" | "deprecated" | "yanked";
export function buildHCS26VersionRegister(skillUid: number, version: string, manifestTopicId: string, checksum: string, status: SkillStatus = "active", m?: string): string {
  return JSON.stringify({ p: "hcs-26", op: "register", skill_uid: skillUid, version, t_id: manifestTopicId, checksum, status, ...(m && { m }) });
}
export function buildHCS26VersionUpdate(uid: string, status: SkillStatus, m?: string): string {
  return JSON.stringify({ p: "hcs-26", op: "update", uid, status, ...(m && { m }) });
}

// --- SKILL.json manifest (stored on HCS-1). A root "SKILL.md" entry is REQUIRED. ---
export interface SkillManifestFile {
  path: string;
  hrl: string; // hcs://1/<topicId>
  sha256: string;
  mime: string;
}
export function buildSkillManifest(args: {
  name: string;
  description: string;
  version: string;
  license: string;
  author: string;
  files: SkillManifestFile[];
  tags?: number[];
  languages?: string[];
  repo?: string;
  commit?: string;
}): string {
  if (!args.files.some((f) => f.path === "SKILL.md")) {
    throw new Error("HCS-26 SKILL.json manifest MUST include a root 'SKILL.md' file entry.");
  }
  return JSON.stringify({
    name: args.name,
    description: args.description,
    version: args.version,
    license: args.license,
    author: args.author,
    ...(args.tags && { tags: args.tags }),
    ...(args.languages && { languages: args.languages }),
    ...(args.repo && { repo: args.repo }),
    ...(args.commit && { commit: args.commit }),
    files: args.files,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-25 — AI TRUST SCORE (NEW)
// A METHODOLOGY, not a wire protocol: weighted mean of normalized [0,100] adapters.
// Spec defines NO topic/op — MARS picks the carrier (we emit a mars-trust message).
// ════════════════════════════════════════════════════════════════════════════

export interface TrustAdapter {
  name: string;
  total: number; // 0..100 (clamped)
  weight?: number; // default 1
}
export interface TrustScoreResult {
  trustScores: { total: number };
  trustScore: number;
  trustScoreUpdatedAt: string;
  trustScoreConfigVersion: number;
  trustConfidence?: number; // 0..1
  breakdown: Array<{ name: string; total: number; weight: number }>;
}

/** HCS-25 weighted-mean. trustScore = Σ(total·w) / Σ(w); 0 when no adapters contribute. */
export function computeTrustScore(
  adapters: TrustAdapter[],
  configVersion = 1,
  confidence?: number
): TrustScoreResult {
  const clamp = (n: number, hi = 100) => Math.max(0, Math.min(hi, n));
  let num = 0;
  let den = 0;
  const breakdown = adapters.map((a) => {
    const weight = a.weight ?? 1;
    const total = clamp(a.total);
    num += total * weight;
    den += weight;
    return { name: a.name, total, weight };
  });
  const total = den > 0 ? Math.round((num / den) * 100) / 100 : 0;
  return {
    trustScores: { total },
    trustScore: total,
    trustScoreUpdatedAt: new Date().toISOString(),
    trustScoreConfigVersion: configVersion,
    ...(confidence != null && { trustConfidence: clamp(confidence, 1) }),
    breakdown,
  };
}

/** MARS-chosen on-chain carrier for a trust score (HCS-25 defines none). */
export function buildTrustScoreMessage(skillId: string, score: TrustScoreResult): string {
  return JSON.stringify({ p: "mars-trust", op: "score", skill: skillId, ...score });
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-18 — RFQ / DISCOVERY BOARD
// One public, submit-keyless, indexed topic carries all ops. Linkage is by HCS
// sequence number (an announce's seq is referenced by propose.members[].announce_seq;
// a propose's seq is the RFQ id referenced by respond.proposal_seq / complete).
// MARS mapping: propose = open audit job · announce = auditor availability ·
// respond(accept) = auditor quote · complete = requester selects + links HCS-16 room.
// ════════════════════════════════════════════════════════════════════════════

export const hcs18Memo = (indexed = 0, ttl = 300) => `hcs-18:${indexed}:${ttl}`;

export interface PetalInfo {
  account: string;
  name: string;
  priority: number; // 0..1000 (higher = prefers to lead)
}
export interface Capabilities {
  protocols: string[];
  resources?: { compute?: string; storage?: string; bandwidth?: string };
  group_preferences?: { sizes?: number[]; threshold_ratios?: number[] };
}
export interface RfqMember {
  account: string;
  announce_seq?: number;
  priority: number;
  status?: "existing" | "proposed";
}
export interface RfqConfig {
  name: string;
  threshold: number;
  purpose?: string; // audit scope rides here
  reason?: string;
}

export function buildHCS18Announce(petal: PetalInfo, capabilities: Capabilities, uaid?: string, valid_for = 10000): string {
  return JSON.stringify({ p: "hcs-18", op: "announce", data: { petal, ...(uaid && { uaid }), capabilities, valid_for } });
}
export function buildHCS18Propose(members: RfqMember[], config: RfqConfig, existing_flora?: string): string {
  return JSON.stringify({ p: "hcs-18", op: "propose", data: { members, config, ...(existing_flora && { existing_flora }) } });
}
export function buildHCS18Respond(proposal_seq: number, decision: "accept" | "reject", reason?: string, accepted_seq?: number): string {
  return JSON.stringify({ p: "hcs-18", op: "respond", data: { proposal_seq, decision, ...(reason && { reason }), ...(accepted_seq != null && { accepted_seq }) } });
}
export function buildHCS18Complete(proposal_seq: number, flora_account_id: string, topics: { communication: string; transaction: string; state: string }): string {
  return JSON.stringify({ p: "hcs-18", op: "complete", data: { proposal_seq, flora_account_id, topics } });
}
export function buildHCS18Withdraw(announce_seq: number, reason?: string): string {
  return JSON.stringify({ p: "hcs-18", op: "withdraw", data: { announce_seq, ...(reason && { reason }) } });
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-16 — FLORA COMMS ROOM (negotiation; COMMUNICATION, not voting)
// 3 topics per Flora: comms(0) / transaction(1) / state(2). operator_id = signer@flora.
// ════════════════════════════════════════════════════════════════════════════

export const hcs16Memo = (floraId: string, type: 0 | 1 | 2) => `hcs-16:${floraId}:${type}`;

export function buildHCS16FloraCreated(floraAccountId: string, communication: string, transaction: string, state: string, m?: string): string {
  return JSON.stringify({ p: "hcs-16", op: "flora_created", flora_account_id: floraAccountId, topics: { communication, transaction, state }, ...(m && { m }) });
}
/** MARS app-private free-text negotiation. NOTE: HCS-16 has no canonical free 'message'
 *  op — generic indexers won't parse this; it's our quote/chat channel on the CTopic. */
export function buildHCS16Chat(senderId: string, floraAccountId: string, data: string): string {
  return JSON.stringify({ p: "hcs-16", op: "message", operator_id: `${senderId}@${floraAccountId}`, data, timestamp: new Date().toISOString() });
}
/** Canonical coordination message (carries a scheduled-tx proposal). */
export function buildHCS16Transaction(senderId: string, floraAccountId: string, scheduleId: string, data?: string, m?: string): string {
  return JSON.stringify({ p: "hcs-16", op: "transaction", operator_id: `${senderId}@${floraAccountId}`, schedule_id: scheduleId, ...(data && { data }), ...(m && { m }) });
}
export function buildHCS16JoinRequest(candidateId: string, connectionTopicId: string, connectionRequestId: number, connectionSeq: number, m?: string): string {
  return JSON.stringify({ p: "hcs-16", op: "flora_join_request", account_id: candidateId, connection_request_id: connectionRequestId, connection_topic_id: connectionTopicId, connection_seq: connectionSeq, ...(m && { m }) });
}
export function buildHCS16JoinVote(voterId: string, floraAccountId: string, candidateId: string, approve: boolean, connectionRequestId: number, connectionSeq: number, m?: string): string {
  return JSON.stringify({ p: "hcs-16", op: "flora_join_vote", account_id: candidateId, approve, operator_id: `${voterId}@${floraAccountId}`, connection_request_id: connectionRequestId, connection_seq: connectionSeq, ...(m && { m }) });
}
export function buildHCS16StateUpdate(hash: string, epoch?: number, m?: string): string {
  return JSON.stringify({ p: "hcs-16", op: "state_update", hash, ...(epoch != null && { epoch }), timestamp: new Date().toISOString(), ...(m && { m }) });
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-11 — AGENT PROFILE   (account memo `hcs-11:hcs://1/<topicId>`)
// ════════════════════════════════════════════════════════════════════════════

export const hcs11AccountMemo = (profileTopicId: string) => `hcs-11:hcs://1/${profileTopicId}`;

export interface ProfileOptions {
  bio?: string;
  uaid?: string;
  inboundTopicId?: string;
  outboundTopicId?: string;
  creator?: string;
  properties?: Record<string, unknown>;
  aiAgentType?: 0 | 1; // 0 manual, 1 autonomous
}

export function buildHCS11Profile(
  displayName: string,
  accountId: string,
  capabilities: number[],
  model: string,
  opts: ProfileOptions = {}
): string {
  return JSON.stringify({
    version: "1.0",
    type: 1, // ai_agent
    display_name: displayName,
    uaid: opts.uaid ?? buildUAID(accountId, { inboundTopicId: opts.inboundTopicId }),
    ...(opts.bio && { bio: opts.bio }),
    ...(opts.inboundTopicId && { inboundTopicId: opts.inboundTopicId }),
    ...(opts.outboundTopicId && { outboundTopicId: opts.outboundTopicId }),
    aiAgent: { type: opts.aiAgentType ?? 1, capabilities, model, creator: opts.creator ?? "MARS" },
    properties: { hederaAccountId: accountId, ...(opts.properties ?? {}) },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-14 — UNIVERSAL AGENT ID (uaid)  — carried inside HCS-11 profiles
// ════════════════════════════════════════════════════════════════════════════

/** Build an HCS-14 uaid. NOTE: a production uaid wraps a real did:hedera; the MVP
 *  uses the account-derived method-specific id but honors the param grammar/order. */
export function buildUAID(
  accountId: string,
  opts: { inboundTopicId?: string; network?: string; didMethodSpecificId?: string } = {}
): string {
  const network = opts.network ?? "testnet";
  const uid = opts.inboundTopicId ? `${opts.inboundTopicId}@${accountId}` : accountId;
  const did = opts.didMethodSpecificId ?? `hedera:${network}:${accountId}`;
  return `uaid:did:${did};uid=${uid};proto=hcs-10;nativeId=hedera:${network}:${accountId}`;
}

// ════════════════════════════════════════════════════════════════════════════
// HCS-20 — AUDITABLE POINTS (reputation / reviews). All numeric values are STRINGS.
// ════════════════════════════════════════════════════════════════════════════

export const HCS20_MEMO = "hcs-20";

export function buildHCS20Deploy(name: string, tick: string, max: string, lim?: string, metadata?: string, m?: string): string {
  return JSON.stringify({ p: "hcs-20", op: "deploy", name, tick: tick.toLowerCase().trim(), max, ...(lim && { lim }), ...(metadata && { metadata }), ...(m && { m }) });
}
export function buildHCS20Mint(tick: string, amt: string, to: string, m?: string): string {
  return JSON.stringify({ p: "hcs-20", op: "mint", tick: tick.toLowerCase().trim(), amt, to, ...(m && { m }) });
}
export function buildHCS20Burn(tick: string, amt: string, from: string, m?: string): string {
  return JSON.stringify({ p: "hcs-20", op: "burn", tick: tick.toLowerCase().trim(), amt, from, ...(m && { m }) });
}
export function buildHCS20Transfer(tick: string, amt: string, from: string, to: string, m?: string): string {
  return JSON.stringify({ p: "hcs-20", op: "transfer", tick: tick.toLowerCase().trim(), amt, from, to, ...(m && { m }) });
}

export function computeHCS20Balances(messages: MirrorMessage[]): {
  tickers: Record<string, { name: string; max: number; lim: number; totalMinted: number }>;
  balances: Record<string, Record<string, number>>;
} {
  const tickers: Record<string, { name: string; max: number; lim: number; totalMinted: number }> = {};
  const balances: Record<string, Record<string, number>> = {};
  for (const msg of messages) {
    if (msg.p !== "hcs-20") continue;
    const tick = msg.tick as string;
    switch (msg.op) {
      case "deploy":
        tickers[tick] = {
          name: msg.name as string,
          max: parseInt(msg.max as string) || Infinity,
          lim: parseInt(msg.lim as string) || Infinity,
          totalMinted: 0,
        };
        if (!balances[tick]) balances[tick] = {};
        break;
      case "mint": {
        const ticker = tickers[tick];
        if (!ticker) break;
        const amt = parseInt(msg.amt as string);
        if (amt > ticker.lim || ticker.totalMinted + amt > ticker.max) break;
        ticker.totalMinted += amt;
        if (!balances[tick]) balances[tick] = {};
        const to = msg.to as string;
        balances[tick][to] = (balances[tick][to] || 0) + amt;
        break;
      }
      case "burn": {
        const amt = parseInt(msg.amt as string);
        const from = msg.from as string;
        if (!balances[tick]?.[from] || balances[tick][from] < amt) break;
        balances[tick][from] -= amt;
        break;
      }
      case "transfer": {
        const amt = parseInt(msg.amt as string);
        const from = msg.from as string;
        const to = msg.to as string;
        if (!balances[tick]?.[from] || balances[tick][from] < amt) break;
        balances[tick][from] -= amt;
        balances[tick][to] = (balances[tick][to] || 0) + amt;
        break;
      }
    }
  }
  return { tickers, balances };
}

/** Net reputation from two HCS-20 tickers (good/bad voting): net = up − down, per account.
 *  voteGood = mint to the `up` tick, voteBad = mint to the `down` tick, removeVote = burn. */
export function computeReputation(
  messages: MirrorMessage[],
  upTick = "good",
  downTick = "bad"
): Record<string, { up: number; down: number; net: number }> {
  const { balances } = computeHCS20Balances(messages);
  const up = balances[upTick.toLowerCase().trim()] ?? {};
  const down = balances[downTick.toLowerCase().trim()] ?? {};
  const out: Record<string, { up: number; down: number; net: number }> = {};
  for (const a of new Set([...Object.keys(up), ...Object.keys(down)])) {
    out[a] = { up: up[a] ?? 0, down: down[a] ?? 0, net: (up[a] ?? 0) - (down[a] ?? 0) };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// REVIEWS & RATINGS  (quality only — never overrides the safety verdict; §4)
// World-ID-gated, proof-of-use: a reviewer rates a skill OR an auditor 1–5 + a note.
// ════════════════════════════════════════════════════════════════════════════

export interface Review {
  target: string; // skill id or auditor account being reviewed
  reviewer: string; // reviewer account
  rating: number; // 1..5 stars (clamped)
  comment?: string;
  role?: "skill" | "auditor"; // what is being reviewed
  licenseSerial?: string; // proof-of-use (the HTS license held)
}

export function buildReview(r: Review): string {
  return JSON.stringify({
    p: "mars-review",
    op: "review",
    target: r.target,
    reviewer: r.reviewer,
    rating: Math.max(1, Math.min(5, Math.round(r.rating))),
    ...(r.comment && { comment: r.comment }),
    ...(r.role && { role: r.role }),
    ...(r.licenseSerial && { license: r.licenseSerial }),
    timestamp: new Date().toISOString(),
  });
}

export interface ReviewSummary {
  count: number;
  avg: number;
  reviews: Array<{ reviewer: string; rating: number; comment?: string; timestamp: string }>;
}

/** Aggregate reviews per target → count + average rating + the individual reviews. */
export function computeReviews(messages: MirrorMessage[]): Record<string, ReviewSummary> {
  const acc: Record<string, { sum: number; reviews: ReviewSummary["reviews"] }> = {};
  for (const m of messages) {
    if (m.p !== "mars-review" || m.op !== "review") continue;
    const target = m.target as string;
    if (!acc[target]) acc[target] = { sum: 0, reviews: [] };
    const rating = Number(m.rating) || 0;
    acc[target].sum += rating;
    acc[target].reviews.push({
      reviewer: m.reviewer as string,
      rating,
      comment: m.comment as string | undefined,
      timestamp: m._timestamp,
    });
  }
  const out: Record<string, ReviewSummary> = {};
  for (const [target, v] of Object.entries(acc)) {
    out[target] = {
      count: v.reviews.length,
      avg: v.reviews.length ? Math.round((v.sum / v.reviews.length) * 100) / 100 : 0,
      reviews: v.reviews,
    };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// MARS MAIN REGISTRY — the index. ONE HCS-2 topic that logs every agent
// (author/auditor/user) and every job; each entry points to its own sub-topic
// (agent → HCS-11 profile topic, job → audit-trail topic). "HCS inside HCS."
// ════════════════════════════════════════════════════════════════════════════

export type AgentRole = "author" | "auditor" | "user";

export function buildAgentRegistered(p: {
  account: string;
  role: AgentRole;
  profileTopicId?: string;
  votingTopicId?: string; // the agent's OWN good/bad voting HCS
  reviewTopicId?: string; // the agent's OWN review HCS
  evmAddress?: string;
  worldVerified?: boolean; // World ID agentkit: is the agent's address human-backed?
  humanId?: string | null; // World AgentBook human id (anti-sybil)
}): string {
  return JSON.stringify({
    p: "mars-registry",
    op: "agent_registered",
    account: p.account,
    role: p.role,
    ...(p.profileTopicId && { profile_topic_id: p.profileTopicId }),
    ...(p.votingTopicId && { voting_topic_id: p.votingTopicId }),
    ...(p.reviewTopicId && { review_topic_id: p.reviewTopicId }),
    ...(p.evmAddress && { evm_address: p.evmAddress }),
    ...(p.worldVerified != null && { world_verified: p.worldVerified }),
    ...(p.humanId && { human_id: p.humanId }),
    timestamp: new Date().toISOString(),
  });
}

export function buildJobPosted(p: {
  jobId: string;
  skill: string;
  requester: string;
  scope?: string;
  auditTrailTopicId?: string;
  status?: string;
}): string {
  return JSON.stringify({
    p: "mars-registry",
    op: "job_posted",
    job_id: p.jobId,
    skill: p.skill,
    requester: p.requester,
    ...(p.scope && { scope: p.scope }),
    ...(p.auditTrailTopicId && { audit_trail_topic_id: p.auditTrailTopicId }),
    status: p.status ?? "open",
    timestamp: new Date().toISOString(),
  });
}

export function buildJobUpdated(p: {
  jobId: string;
  status: string;
  auditor?: string;
  verdict?: string;
  trustScore?: number;
  note?: string;
}): string {
  return JSON.stringify({
    p: "mars-registry",
    op: "job_updated",
    job_id: p.jobId,
    status: p.status,
    ...(p.auditor && { auditor: p.auditor }),
    ...(p.verdict && { verdict: p.verdict }),
    ...(p.trustScore != null && { trust_score: p.trustScore }),
    ...(p.note && { note: p.note }),
    timestamp: new Date().toISOString(),
  });
}

/** Log a completed World ID verification (the verifier's nullifier / evm hash) to the main registry. */
export function buildHumanVerified(
  nullifier: string,
  opts: { evmAddress?: string; signalHash?: string; account?: string } = {}
): string {
  return JSON.stringify({
    p: "mars-registry",
    op: "human_verified",
    nullifier,
    ...(opts.evmAddress && { evm_address: opts.evmAddress }),
    ...(opts.signalHash && { signal_hash: opts.signalHash }),
    ...(opts.account && { account: opts.account }),
    timestamp: new Date().toISOString(),
  });
}

export interface RegistryView {
  agents: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  humans: Array<Record<string, unknown>>;
}

/** Replay the main registry → current list of agents + jobs (job updates fold into their job). */
export function computeRegistry(messages: MirrorMessage[]): RegistryView {
  const agents: Record<string, Record<string, unknown>> = {};
  const jobs: Record<string, Record<string, unknown>> = {};
  const humans: Record<string, Record<string, unknown>> = {};
  for (const m of messages) {
    if (m.p !== "mars-registry") continue;
    if (m.op === "agent_registered") {
      agents[m.account as string] = {
        account: m.account,
        role: m.role,
        profile_topic_id: m.profile_topic_id,
        voting_topic_id: m.voting_topic_id,
        review_topic_id: m.review_topic_id,
        evm_address: m.evm_address,
        world_verified: m.world_verified,
        human_id: m.human_id,
        _seq: m._seq,
      };
    } else if (m.op === "job_posted") {
      jobs[m.job_id as string] = {
        job_id: m.job_id,
        skill: m.skill,
        requester: m.requester,
        scope: m.scope,
        audit_trail_topic_id: m.audit_trail_topic_id,
        status: m.status,
        _seq: m._seq,
      };
    } else if (m.op === "job_updated") {
      const j = jobs[m.job_id as string];
      if (j) {
        j.status = m.status;
        if (m.auditor) j.auditor = m.auditor;
        if (m.verdict) j.verdict = m.verdict;
        if (m.trust_score != null) j.trust_score = m.trust_score;
        if (m.note) j.note = m.note;
      }
    } else if (m.op === "human_verified") {
      humans[m.nullifier as string] = {
        nullifier: m.nullifier,
        evm_address: m.evm_address,
        signal_hash: m.signal_hash,
        account: m.account,
        _seq: m._seq,
      };
    }
  }
  // a skill is VERIFIED only once the requester approves a SAFE audit (status flips to "verified");
  // any later append that sets a different status (e.g. "revoked"/"rejected") un-verifies it on replay.
  const jobList = Object.values(jobs).map((j) => ({ ...j, verified: j.status === "verified" }));
  return { agents: Object.values(agents), jobs: jobList, humans: Object.values(humans) };
}

// ════════════════════════════════════════════════════════════════════════════
// MARS AUDIT TRAIL — per-test live HCS messages (README §3 step 4) + verdict
// ════════════════════════════════════════════════════════════════════════════

export function buildAuditStep(skillId: string, step: string, status: "pass" | "fail" | "info", detail?: string): string {
  return JSON.stringify({ p: "mars-audit", op: "step", skill: skillId, step, status, ...(detail && { detail }), timestamp: new Date().toISOString() });
}
export function buildAuditVerdict(skillId: string, verdict: "SAFE" | "DANGEROUS", trustScore: number, reportHrl: string, attestation?: string): string {
  return JSON.stringify({ p: "mars-audit", op: "verdict", skill: skillId, verdict, trustScore, report: reportHrl, ...(attestation && { attestation }), timestamp: new Date().toISOString() });
}

// --- Real-pipeline audit records (derek's runAuditPipeline → HCS). Each message is kept
//     well under the 1KB HCS limit; the FULL untruncated report is stored on HCS-1. ---
export interface AuditFinding { severity: string; title: string; detail?: string }

const SEV_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Try increasingly compact variants, return the first JSON ≤1000 bytes (HCS single-message limit). */
function fitMessage(variants: Array<Record<string, unknown>>): string {
  for (const v of variants) {
    const s = JSON.stringify(v);
    if (Buffer.byteLength(s, "utf-8") <= 1000) return s;
  }
  return JSON.stringify(variants[variants.length - 1]);
}

/** One real audit STAGE (scanner/sandbox/fork) → a rich HCS message: summary, severity histogram,
 *  total finding count, model, and the findings (with details when they fit). Status from worst finding. */
export function buildAuditStage(skillId: string, stage: string, summary: string, findings: AuditFinding[] = [], model?: string): string {
  const sev = (f: AuditFinding) => String(f.severity).toLowerCase();
  const worst = findings.reduce((m, f) => Math.max(m, SEV_RANK[sev(f)] ?? 0), 0);
  const status = worst >= 3 ? "fail" : worst === 2 ? "warn" : "pass";
  const severities: Record<string, number> = {};
  for (const f of findings) severities[sev(f)] = (severities[sev(f)] ?? 0) + 1;
  const variant = (n: number, detail: boolean, sumLen: number) => ({
    p: "mars-audit", op: "stage", skill: skillId, stage, status,
    summary: String(summary || "").slice(0, sumLen),
    finding_count: findings.length,
    severities,
    ...(model && { model }),
    findings: findings.slice(0, n).map((f) => ({
      severity: sev(f),
      title: String(f.title).slice(0, 80),
      ...(detail && f.detail ? { detail: String(f.detail).slice(0, 130) } : {}),
    })),
    timestamp: new Date().toISOString(),
  });
  return fitMessage([variant(6, true, 240), variant(5, true, 180), variant(6, false, 160), variant(4, false, 120), variant(3, false, 90)]);
}

export interface FullVerdict {
  verdict: "SAFE" | "DANGEROUS";
  risk?: string;
  summary?: string;
  capabilities?: string[]; // "what the skill ACTUALLY does"
  recommendation?: string;
  trustScore?: number;
  model?: string;
  reportHrl?: string; // hcs://1/<id> — the full audit report
  attestation?: string;
}
/** The final verdict → HCS. Carries `capabilities` + risk + recommendation + model so the task topic is
 *  a complete, replayable record (the dashboard's "verified skills" read this). Capped to ≤1KB. */
export function buildAuditVerdictFull(skillId: string, v: FullVerdict): string {
  const variant = (sumLen: number, capN: number, capLen: number, recLen: number) => ({
    p: "mars-audit", op: "verdict", skill: skillId,
    verdict: v.verdict,
    ...(v.risk && { risk: v.risk }),
    ...(v.trustScore != null && { trustScore: v.trustScore }),
    ...(v.model && { model: v.model }),
    ...(v.summary && { summary: String(v.summary).slice(0, sumLen) }),
    ...(v.capabilities?.length && { capabilities: v.capabilities.slice(0, capN).map((c) => String(c).slice(0, capLen)) }),
    ...(v.recommendation && { recommendation: String(v.recommendation).slice(0, recLen) }),
    ...(v.reportHrl && { report: v.reportHrl }),
    ...(v.attestation && { attestation: v.attestation }),
    timestamp: new Date().toISOString(),
  });
  return fitMessage([variant(340, 8, 84, 170), variant(260, 6, 72, 130), variant(200, 5, 64, 100), variant(140, 4, 56, 80)]);
}

/** Map an audit risk band → a 0-100 trust score (for the dashboard / HCS-25-style display). */
export function riskToTrust(risk?: string): number {
  return ({ none: 96, low: 82, medium: 50, high: 18, critical: 6 } as Record<string, number>)[String(risk).toLowerCase()] ?? 50;
}

// ── Post-audit lifecycle on the task topic: requester decision → auditor review → HTS mint ──
/** Requester approves / disapproves the verdict. */
export function buildTaskDecision(skillId: string, actor: string, decision: "approved" | "disapproved", verdict?: string, note?: string): string {
  return JSON.stringify({ p: "mars-task", op: "decision", skill: skillId, actor, decision, ...(verdict && { verdict }), ...(note && { note: String(note).slice(0, 160) }), timestamp: new Date().toISOString() });
}
/** Requester rates + reviews the auditor (also written to the auditor's own review + voting HCS). */
export function buildTaskReviewed(skillId: string, auditor: string, rating: number, comment?: string, reviewTopicId?: string, votingTopicId?: string): string {
  return JSON.stringify({ p: "mars-task", op: "reviewed", skill: skillId, auditor, rating: Math.max(1, Math.min(5, Math.round(rating))), ...(comment && { comment: String(comment).slice(0, 160) }), ...(reviewTopicId && { review_topic_id: reviewTopicId }), ...(votingTopicId && { voting_topic_id: votingTopicId }), timestamp: new Date().toISOString() });
}
/** A VERIFIED HTS NFT was minted for the (approved) skill. */
export function buildTaskMinted(skillId: string, tokenId: string, serial: string, owner: string, metadata?: string): string {
  return JSON.stringify({ p: "mars-task", op: "minted", skill: skillId, token: tokenId, serial, owner, ...(metadata && { metadata }), timestamp: new Date().toISOString() });
}

// ── Cross-chain payment leg (Arc): both sides lock USDC into MarsEscrow on agreement,
//    then it's released to the auditor once the audit is done. Recorded on the Hedera task
//    topic so the one trail shows the money moving alongside the verdict. Arc tx hashes are
//    verifiable on Arcscan; this is the Hedera-side receipt of the Arc settlement. ──
/** Both sides funded the Arc escrow (developer fee + auditor bond locked → Funded). */
export function buildEscrowFunded(skillId: string, e: { chain?: string; jobId: number; escrow: string; developer: string; auditor: string; fee: string; bond: string; status?: string; createTx: string; fundFeeTx: string; postBondTx: string }): string {
  return JSON.stringify({ p: "mars-task", op: "escrow_funded", skill: skillId, chain: e.chain ?? "arc-testnet", job_id: e.jobId, escrow: e.escrow, developer: e.developer, auditor: e.auditor, fee: e.fee, bond: e.bond, status: e.status ?? "Funded", create_tx: e.createTx, fund_fee_tx: e.fundFeeTx, post_bond_tx: e.postBondTx, timestamp: new Date().toISOString() });
}
/** The Arc escrow was resolved — SETTLE (fee+bond → auditor) or SLASH (bond → reporter, fee → developer). */
export function buildEscrowResolved(skillId: string, e: { chain?: string; jobId: number; outcome: "settled" | "slashed"; tx: string; paidTo: string; amount: string; feeRefunded?: string; status?: string }): string {
  return JSON.stringify({ p: "mars-task", op: "escrow_resolved", skill: skillId, chain: e.chain ?? "arc-testnet", job_id: e.jobId, outcome: e.outcome, tx: e.tx, paid_to: e.paidTo, amount: e.amount, ...(e.feeRefunded && { fee_refunded: e.feeRefunded }), status: e.status ?? (e.outcome === "settled" ? "Settled" : "Slashed"), timestamp: new Date().toISOString() });
}

// ════════════════════════════════════════════════════════════════════════════
// MARS TASK — the per-task topic's INIT message. The task topic is created when a
// requesting agent accepts an auditor's quote ("create task"); replaying it gives
// the full ordered log: init (terms + skill content) → mars-audit steps → verdict.
// The agreed terms (price/scope/bond/time) are the OUTCOME of the simulated nego
// that happened live in the HCS-16 chat room. Skill content rides inline when it
// fits the 1KB HCS message; otherwise the caller stores it on HCS-1 and passes an
// `hcs://1/<id>` HRL as `content`.
// ════════════════════════════════════════════════════════════════════════════

export interface TaskInit {
  skill: string; // skill name (e.g. "price-checker")
  content: string; // the skill source, OR an hcs://1/<id> HRL when too large
  scope: string; // what to check (e.g. "network · keys · wallet")
  requester: string; // the agent that posted the ask (= the payer)
  auditor: string; // the agent that won the quote
  price: string; // accepted quote (audit fee → escrow)
  bond: string; // auditor's honesty bond
  time: string; // agreed turnaround (e.g. "~10m")
  description?: string; // the skill's DECLARED description (what it claims to do)
  files?: string[]; // the file(s) submitted for audit
  version?: string;
  tier?: string; // T1 / T2 / automated / SOC2 …
  compliance?: string;
  contentHrl?: string; // set when content was offloaded to HCS-1
  contentHash?: string; // sha256 of the original skill source
  chatRoomTopicId?: string; // back-link to the room the nego happened in
  status?: string; // task lifecycle: "posted" (created, not started) → "agreed" (default)
  m?: string;
}

/** Build the `mars-task` init message — the job manifest: WHO (payer + auditor), WHAT (skill +
 *  description + files + content), the SCOPE, and the agreed TERMS. */
export function buildTaskInit(t: TaskInit): string {
  return JSON.stringify({
    p: "mars-task",
    op: "init",
    skill: t.skill,
    ...(t.version && { version: t.version }),
    ...(t.description && { description: t.description }),
    content: t.content,
    ...(t.contentHrl && { content_hrl: t.contentHrl }),
    ...(t.contentHash && { content_hash: t.contentHash }),
    ...(t.files?.length && { files: t.files }),
    scope: t.scope,
    ...(t.tier && { tier: t.tier }),
    ...(t.compliance && { compliance: t.compliance }),
    payer: t.requester, // WHO pays the audit fee (escrow) — explicit alias for the requester
    requester: t.requester,
    auditor: t.auditor,
    price: t.price,
    bond: t.bond,
    time: t.time,
    ...(t.chatRoomTopicId && { chat_room_topic_id: t.chatRoomTopicId }),
    status: t.status ?? "agreed", // "posted" = created but not started; "agreed" once negotiated
    ...(t.m && { m: t.m }),
    timestamp: new Date().toISOString(),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULED TX — re-audit on update
// NOTE: SDK scheduled txns execute when signatures are collected, NOT on a wall
// clock. For true time-based recurring re-audits use the HSS contract approach from
// SPARK (HederaScheduleService.sol self-rescheduling loop). See README §12.
// ════════════════════════════════════════════════════════════════════════════

export async function scheduleReAudit(
  client: Client,
  auditTrailTopicId: string,
  payload: string,
  memo = "MARS re-audit"
): Promise<{ scheduleId: string; scheduledTxId: string }> {
  const inner = new TopicMessageSubmitTransaction()
    .setTopicId(auditTrailTopicId)
    .setMessage(payload);
  const receipt = await (
    await new ScheduleCreateTransaction()
      .setScheduledTransaction(inner)
      .setScheduleMemo(memo)
      .execute(client)
  ).getReceipt(client);
  return {
    scheduleId: receipt.scheduleId!.toString(),
    scheduledTxId: receipt.scheduledTransactionId!.toString(),
  };
}
