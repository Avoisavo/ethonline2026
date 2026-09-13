import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anchorStatus, pushAnchors, readReceipts, type AnchorConfig, type AnchorSubmit } from '../src/consensus/anchor.js';
import { anchorsPath, logPath, worldChecksPath } from '../src/store/paths.js';

const cfg: AnchorConfig = { createdTx: '0.0.1@1.2', network: 'testnet', topicId: '0.0.777' };

function treeWith(logLines: string[], worldLines: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'petri-anchor-'));
  mkdirSync(join(root, '.petri'), { recursive: true });
  writeFileSync(logPath(root), logLines.map((l) => `${l}\n`).join(''));
  if (worldLines.length > 0) writeFileSync(worldChecksPath(root), worldLines.map((l) => `${l}\n`).join(''));
  return root;
}

function fakeTopic(): { submit: AnchorSubmit; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    submit: async (bytes) => {
      sent.push(bytes.toString('utf8'));
      return { hcsSeq: sent.length, txId: `0.0.1@${sent.length}` };
    },
  };
}

test('every log line and World ID line is sent once, in order, as the exact bytes', async () => {
  const root = treeWith(['{"seq":1}', '{"seq":2}'], ['{"kind":"petri/world-check/1"}']);
  const topic = fakeTopic();
  const result = await pushAnchors(root, cfg, topic.submit);
  assert.equal(result.error, null);
  assert.deepEqual(topic.sent, ['{"seq":1}', '{"seq":2}', '{"kind":"petri/world-check/1"}']);
  assert.deepEqual(readReceipts(root).map((r) => `${r.source}:${r.localSeq}:${r.hcsSeq}`), ['log:1:1', 'log:2:2', 'world:1:3']);

  const again = await pushAnchors(root, cfg, topic.submit);
  assert.equal(again.pushed.length, 0);
  assert.equal(topic.sent.length, 3);
});

test('a new line is sent on the next push, and nothing before it', async () => {
  const root = treeWith(['{"seq":1}']);
  const topic = fakeTopic();
  await pushAnchors(root, cfg, topic.submit);
  appendFileSync(logPath(root), '{"seq":2}\n');
  assert.equal(anchorStatus(root).pending.length, 1);
  await pushAnchors(root, cfg, topic.submit);
  assert.deepEqual(topic.sent, ['{"seq":1}', '{"seq":2}']);
  assert.equal(anchorStatus(root).anchored, 2);
});

test('a failed send stops the push and keeps the receipts written before it', async () => {
  const root = treeWith(['{"seq":1}', '{"seq":2}', '{"seq":3}']);
  let calls = 0;
  const result = await pushAnchors(root, cfg, async () => {
    calls += 1;
    if (calls === 2) throw new Error('INSUFFICIENT_PAYER_BALANCE');
    return { hcsSeq: calls, txId: `0.0.1@${calls}` };
  });
  assert.match(result.error ?? '', /log line 2 did not reach 0\.0\.777: INSUFFICIENT_PAYER_BALANCE/);
  assert.equal(readReceipts(root).length, 1);
  assert.equal(anchorStatus(root).pending.length, 2);
});

test('a line changed after it reached Hedera is reported, and the push refuses to continue', async () => {
  const root = treeWith(['{"seq":1}']);
  await pushAnchors(root, cfg, fakeTopic().submit);
  writeFileSync(logPath(root), '{"seq":1,"edited":true}\n{"seq":2}\n');
  const status = anchorStatus(root);
  assert.equal(status.changed.length, 1);
  const result = await pushAnchors(root, cfg, fakeTopic().submit);
  assert.match(result.error ?? '', /changed after it reached Hedera/);
  assert.equal(readReceipts(root).length, 1);
});

test('a tree with no records and no receipts has nothing to send', () => {
  const root = treeWith([]);
  const s = anchorStatus(root);
  assert.equal(s.total, 0);
  assert.equal(s.pending.length, 0);
  assert.equal(anchorsPath(root).endsWith('anchors.jsonl'), true);
});
