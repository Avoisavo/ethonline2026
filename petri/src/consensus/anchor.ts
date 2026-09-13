/**
 * The Hedera anchor. It copies every record of the tree to a public HCS topic.
 *
 * The local log stays the source of the tree. The anchor sends each log line to
 * the topic as the exact bytes on disk, in sequence order, and it stores one
 * receipt per line. Anyone can then read the topic from the mirror node, join the
 * messages in order, and rebuild `log.jsonl`. The hash chain in each line then
 * proves that no line was changed or removed after it reached Hedera.
 *
 * World ID checks go to the same topic. See src/trust/world.ts.
 *
 * What the anchor adds: a public order and a consensus timestamp for every line,
 * on a topic with no admin key, so nobody can delete it.
 * What it does NOT add: proof that a verifier ran the benchmark, or that two keys
 * are two people. The CLI must not claim either.
 *
 * This is separate from `ledger: hcs` (src/consensus/hedera.ts). That mode reads
 * the tree FROM the topic. The anchor only writes a copy, so a tree that started
 * on the local log keeps every record and every author signature.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { TopicId, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import { z } from 'zod';

import { AccountId } from '../config.js';
import { canonicalJson, sha256Hex } from '../core/canonical.js';
import { Hex64 } from '../core/schema.js';
import { anchorConfigPath, anchorsPath, logPath, worldChecksPath } from '../store/paths.js';
import { HederaError, makeClient, MIRROR_REST, type HederaNetwork } from './hedera.js';

/**
 * A log line is one signed envelope plus its chain fields. The largest one is
 * about 1.1 KB, so it can be larger than one 1024-byte chunk. HCS joins the
 * chunks back in order. Four chunks leave a wide margin.
 */
export const ANCHOR_MAX_CHUNKS = 4;

export const AnchorConfigSchema = z.strictObject({
  createdTx: z.string().min(1).max(128),
  network: z.enum(['testnet', 'mainnet', 'previewnet']),
  topicId: AccountId,
});
export type AnchorConfig = z.infer<typeof AnchorConfigSchema>;

export const AnchorReceiptSchema = z.strictObject({
  hcsSeq: z.int().min(0),
  lineHash: Hex64,
  localSeq: z.int().min(1),
  source: z.enum(['log', 'world']),
  topicId: AccountId,
  txId: z.string().min(1).max(128),
});
export type AnchorReceipt = z.infer<typeof AnchorReceiptSchema>;

/** One line waiting to reach the topic. */
export interface AnchorItem {
  source: 'log' | 'world';
  localSeq: number;
  line: string;
  lineHash: string;
}

/** Sends the bytes of one line to the topic. Tests replace it with a fake. */
export type AnchorSubmit = (bytes: Buffer) => Promise<{ hcsSeq: number; txId: string }>;

export const mirrorMessagesUrl = (cfg: AnchorConfig): string =>
  `${MIRROR_REST[cfg.network]}/api/v1/topics/${cfg.topicId}/messages`;
export const hashscanTopicUrl = (cfg: AnchorConfig): string =>
  `https://hashscan.io/${cfg.network}/topic/${cfg.topicId}`;

export function loadAnchorConfig(root: string): AnchorConfig | null {
  const path = anchorConfigPath(root);
  if (!existsSync(path)) return null;
  const parsed = AnchorConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new HederaError(`petri: ${path} is not a valid anchor config: ${parsed.error.message}`, 1);
  }
  return parsed.data;
}

export function saveAnchorConfig(root: string, cfg: AnchorConfig): void {
  const path = anchorConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(AnchorConfigSchema.parse(cfg), null, 2)}\n`, 'utf8');
}

function linesOf(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

export function readReceipts(root: string): AnchorReceipt[] {
  return linesOf(anchorsPath(root)).map((line, i) => {
    const parsed = AnchorReceiptSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new HederaError(`petri: ${anchorsPath(root)} line ${i + 1} is not a receipt.`, 1);
    }
    return parsed.data;
  });
}

/** Every line of the log and of the World ID file, in the order they are sent. */
export function localItems(root: string): AnchorItem[] {
  const items: AnchorItem[] = [];
  const add = (source: AnchorItem['source'], path: string): void => {
    linesOf(path).forEach((line, i) => {
      items.push({ source, localSeq: i + 1, line, lineHash: sha256Hex(line) });
    });
  };
  add('log', logPath(root));
  add('world', worldChecksPath(root));
  return items;
}

const keyOf = (x: { source: string; localSeq: number }): string => `${x.source}:${x.localSeq}`;

export interface AnchorStatus {
  config: AnchorConfig | null;
  total: number;
  anchored: number;
  pending: AnchorItem[];
  /** A line that changed on disk after its receipt was written. */
  changed: AnchorItem[];
  /** Receipt per log sequence number, for the web view. */
  logReceipts: Map<number, AnchorReceipt>;
}

export function anchorStatus(root: string): AnchorStatus {
  const config = loadAnchorConfig(root);
  const receipts = new Map(readReceipts(root).map((r) => [keyOf(r), r]));
  const items = localItems(root);
  const pending: AnchorItem[] = [];
  const changed: AnchorItem[] = [];
  const logReceipts = new Map<number, AnchorReceipt>();
  for (const item of items) {
    const r = receipts.get(keyOf(item));
    if (r === undefined) pending.push(item);
    else if (r.lineHash !== item.lineHash) changed.push(item);
    else if (r.source === 'log') logReceipts.set(r.localSeq, r);
  }
  return { config, total: items.length, anchored: items.length - pending.length - changed.length, pending, changed, logReceipts };
}

export interface PushResult {
  pushed: AnchorReceipt[];
  error: string | null;
}

/**
 * Send every pending line in order, and write each receipt as soon as it
 * arrives. A failure stops the push. The receipts written before it stay, so
 * the next push starts where this one stopped.
 */
export async function pushAnchors(root: string, cfg: AnchorConfig, submit: AnchorSubmit): Promise<PushResult> {
  const status = anchorStatus(root);
  if (status.changed.length > 0) {
    const first = status.changed[0]!;
    return {
      pushed: [],
      error: `${first.source} line ${first.localSeq} changed after it reached Hedera. ` +
        'The copy on the topic is the original. Nothing more is sent.',
    };
  }
  const pushed: AnchorReceipt[] = [];
  for (const item of status.pending) {
    let sent: { hcsSeq: number; txId: string };
    try {
      sent = await submit(Buffer.from(item.line, 'utf8'));
    } catch (err) {
      return { pushed, error: `${item.source} line ${item.localSeq} did not reach ${cfg.topicId}: ${(err as Error).message}` };
    }
    const receipt: AnchorReceipt = {
      hcsSeq: sent.hcsSeq,
      lineHash: item.lineHash,
      localSeq: item.localSeq,
      source: item.source,
      topicId: cfg.topicId,
      txId: sent.txId,
    };
    mkdirSync(dirname(anchorsPath(root)), { recursive: true });
    appendFileSync(anchorsPath(root), `${canonicalJson(receipt)}\n`, 'utf8');
    pushed.push(receipt);
  }
  return { pushed, error: null };
}

/**
 * The real sender. It needs HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY, and it
 * pays for each message from that account.
 */
export function hcsSubmitter(
  cfg: AnchorConfig, env: NodeJS.ProcessEnv = process.env,
): { submit: AnchorSubmit; close: () => void } {
  const client = makeClient(cfg.network as HederaNetwork, undefined, env);
  if (client.operatorAccountId === null) {
    client.close();
    throw new HederaError(
      'petri: HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY must both be set to write to Hedera.', 5,
    );
  }
  const submit: AnchorSubmit = async (bytes) => {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(cfg.topicId))
      .setMaxChunks(ANCHOR_MAX_CHUNKS)
      .setMessage(bytes)
      .execute(client);
    const receipt = await response.getReceipt(client);
    return {
      hcsSeq: receipt.topicSequenceNumber === null ? 0 : receipt.topicSequenceNumber.toNumber(),
      txId: response.transactionId.toString(),
    };
  };
  return { submit, close: () => client.close() };
}
