# Hedera code — usage guide

Hedera code copied from two hackathon repos, kept side by side and namespaced by source
so nothing collides:

| | `hederaone` (MARS) | `hedera2` (DIVE) |
|---|---|---|
| Library | `lib/hederaone/` | `lib/hedera2/` |
| Demo page | `/hederaone/hedera` | `/hedera2/hedera` |
| API | `POST /api/hederaone/hedera` (one route, `action` switch) | `POST /api/hedera2/{hedera,hcs}/*` (one route per concern) |
| Style | one big consolidated module, ~65 actions | small focused modules, thin routes |

Both target **Hedera testnet**, both use a single operator account that pays for everything,
and both read chain state through the **Mirror Node REST API** rather than SDK queries
(cheaper, and it is the only way to read a topic's full history).

The two are independent — you can delete one whole column without touching the other.
`hedera2` is the earlier, simpler codebase; `hederaone` was built on top of its ideas and
covers more standards.

---

## 1. Setup

```bash
npm install          # deps are already in package.json
```

Create `.env.local`:

```bash
# Required for anything to work — get a testnet account at portal.hedera.com
HEDERA_OPERATOR_ID=0.0.xxxxxx
HEDERA_OPERATOR_KEY=302e0201...        # DER-encoded private key

# Optional
HEDERA_MIRROR_URL=https://testnet.mirrornode.hedera.com   # this is the default

# Only for hederaone's AI-audit actions (runAudit / auditorReply); falls back to
# canned results when unset, so the flow still demos without a key
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
AUDIT_MODEL=gpt-4o

# Only for hederaone's World ID anti-sybil check (fails soft — never blocks)
NEXT_PUBLIC_WORLD_APP_ID=app_...
```

Then `npm run dev` and open `/hederaone/hedera` or `/hedera2/hedera`. Both pages are
self-contained playgrounds — click through them in order and they walk the whole flow.

Every write returns a `hashscan` URL; paste it into a browser to see the transaction on
[HashScan testnet](https://hashscan.io/testnet).

---

## 2. `hedera2` — the simple one

Start here if you are learning the Hedera primitives.

### `lib/hedera2/hedera.ts`

One function. That's the whole file.

```ts
import { getClient } from "@/lib/hedera2/hedera";

const client = getClient();   // Client.forTestnet() with the operator set
// ... do work ...
client.close();               // always close, or the process hangs
```

### `lib/hedera2/hcs-standards.ts`

The interesting file (735 lines). Three kinds of function, and the naming tells you which:

- **`build*`** — pure, synchronous. Returns a JSON string ready to submit as a topic
  message. No network, no client. Trivial to unit-test.
- **`compute*`** — pure, synchronous. Takes the array of messages you read back from the
  Mirror Node and folds it into current state. This is the "replay the log" half.
- **`createTopic` / `submitMessage` / `readTopicMessages`** — the only async ones; they
  touch the network.

That build/compute split is the core idea: **HCS topics are append-only logs, and state is
a fold over them.** Nothing is ever mutated on-chain; you write another message and
recompute.

```ts
import { createTopic, submitMessage, readTopicMessages,
         buildHCS20Mint, computeHCS20Balances, getOperatorKey } from "@/lib/hedera2/hcs-standards";

const client = getClient();
const topicId = await createTopic(client, "hcs-20", getOperatorKey().publicKey);

await submitMessage(client, topicId, buildHCS20Mint("PTS", "100", "0.0.1234"));

const msgs = await readTopicMessages(topicId);          // Mirror Node, no client needed
const { tickers, balances } = computeHCS20Balances(msgs);
// balances.pts["0.0.1234"] === 100   — note: tickers are lower-cased
```

Also in here: commit–reveal voting helpers (`generateSalt`, `hashVote`, `verifyVote`,
`buildHCS16Commit`, `buildHCS16Reveal`, `computeVoteTally`) — used so oracle committee
members cannot see each other's votes before committing.

### `lib/hedera2/agent-helpers.ts`

Reads/writes `hedera-state.json` at the repo root (the file was copied over, and holds the
demo's topic IDs and registered agents). Also reputation updates and committee selection.
This is app glue, not Hedera protocol — treat it as an example.

### Routes

Every route is `POST` only and returns JSON. The five `hedera/*` routes are one
transaction each:

| Route | Body | Does |
|---|---|---|
| `/api/hedera2/hedera/create-account` | `{ initialBalance? }` (default 10 ℏ) | New account + keypair. **Returns the private key in the response** — testnet only. |
| `/api/hedera2/hedera/create-topic` | `{ memo? }` | New HCS topic |
| `/api/hedera2/hedera/submit-message` | `{ topicId, message }` | Append to a topic |
| `/api/hedera2/hedera/create-token` | `{ tokenName?, tokenSymbol?, initialSupply?, decimals? }` | Fungible HTS token, operator as treasury |
| `/api/hedera2/hedera/schedule-transaction` | `{ senderAccountId, receiverAccountId, amount?, memo? }` | A `ScheduleCreateTransaction` HBAR transfer |

The six `hcs/*` routes take an `action` field:

```bash
# HCS-20 points: deploy → mint → transfer → burn → balance
curl -X POST localhost:3000/api/hedera2/hcs/hcs20 \
  -H 'content-type: application/json' \
  -d '{"action":"deploy","name":"Reputation","tick":"REP","max":"1000000"}'
```

| Route | Actions |
|---|---|
| `hcs/hcs2` | `create`, `register`, `update`, `delete`, `read` — a topic registry (a topic whose messages point at other topics) |
| `hcs/hcs11` | `create`, `read` — agent profile |
| `hcs/hcs16` | `create`, `message`, `vote`, `state`, `read`, `commit`, `reveal`, `discussion`, `tally` — a "Flora" multi-agent room with commit–reveal voting |
| `hcs/hcs20` | `deploy`, `mint`, `burn`, `transfer`, `balance` — auditable points |
| `hcs/register-agent` | *(no action)* `{ displayName, accountId, capabilities?, model?, bio?, registryTopicId?, reputationTopicId? }` — does HCS-11 + HCS-2 + HCS-20 in one call |
| `hcs/discover-agents` | `{ registryTopicId }` — read the registry back |

`docs/hedera-usages.md` is the original repo's line-by-line index of where each standard
is used upstream — useful, but its links point at the source repo's paths, not ours.

---

## 3. `hederaone` — the consolidated one

Same protocols, much wider surface, plus an opinionated application flow (an AI skill
marketplace: authors publish skills, auditors audit them, users buy licenses).

### `lib/hederaone/hedera.ts`

1291 lines, organized as **banner blocks** — one `// ═══` block per concern. The file's own
header says it: to drop a standard, delete its block here *and* its `case`s in the API
route. Same `build*` / `compute*` / async-network split as hedera2.

Blocks, in file order:

| Block | Key exports |
|---|---|
| Config & client | `getClient`, `getOperatorId`, `getOperatorKey`, `hashscan` |
| Mirror Node reader | `readTopicMessages` |
| Topic helpers | `createTopic`, `submitMessage` |
| Accounts | `createAgentAccount` |
| HTS NFTs | `createVerifiedCollection`, `createLicenseCollection`, `mintNft`, `checkNft`, `associateToken`, `transferNft` |
| HCS-1 file storage | `uploadFileHCS1`, `downloadFileHCS1` |
| HCS-2 registry | `hcs2Memo`, `buildHCS2Register/Update/Delete`, `computeHCS2State` |
| HCS-26 skills registry | `buildHCS26SkillRegister`, `buildHCS26VersionRegister`, `buildSkillManifest` |
| HCS-25 trust score | `computeTrustScore`, `buildTrustScoreMessage` |
| HCS-18 RFQ board | `buildHCS18Announce/Propose/Respond/Complete/Withdraw` |
| HCS-16 Flora room | `buildHCS16FloraCreated`, `buildHCS16Chat`, `buildHCS16JoinVote`, … |
| HCS-11 profile + HCS-14 uaid | `hcs11AccountMemo`, `buildHCS11Profile`, `buildUAID` |
| HCS-20 points | `buildHCS20Deploy/Mint/Burn/Transfer`, `computeHCS20Balances`, `computeReputation` |
| Reviews & ratings | `buildReview`, `computeReviews` |
| Main registry | `buildAgentRegistered`, `buildJobPosted`, `computeRegistry` |
| Audit trail | `buildAuditStep`, `buildAuditStage`, `buildAuditVerdictFull`, `riskToTrust` |
| Task | `buildTaskInit`, `buildTaskDecision`, `buildTaskMinted` |
| Scheduled tx | `scheduleReAudit` |

Two details worth knowing:

- **HCS-1** chunks a file into `{o, c}` messages, brotli-compresses it, and puts
  `<sha256>:brotli:base64` in the topic memo. The topic gets a submit key and **no admin
  key**, which makes it immutable and content-addressed. Uploading the same bytes twice
  gives you the same hash.
- **NFT metadata is a pointer, not data** — Hedera caps NFT metadata at 100 bytes, so the
  metadata field holds an HRL (`hcs://1/0.0.xxxx`) into an HCS-1 topic that holds the real
  payload.

### `POST /api/hederaone/hedera`

One route, `{ action, ...params }`, ~65 actions. Every capability in the lib is reachable
from here.

```bash
curl -X POST localhost:3000/api/hederaone/hedera \
  -H 'content-type: application/json' \
  -d '{"action":"createAccount"}'
```

Grouped:

- **Accounts** — `createAccount`, `worldCheck`
- **Topics** — `createTopic`, `submitMessage`, `readTopic`
- **NFTs** — `createVerifiedCollection`, `createLicenseCollection`, `mintNft`, `checkNft`, `associateToken`, `transferNft`
- **Files (HCS-1)** — `uploadReport`, `downloadReport`, `uploadManifest`
- **Registry (HCS-2)** — `createRegistry`, `registerInRegistry`, `readRegistry`, `createMainRegistry`, `readMainRegistry`
- **Skills (HCS-26)** — `createSkillsRegistry`, `createVersionRegistry`, `registerSkill`, `registerVersion`, `resolveSkill`
- **Trust (HCS-25)** — `trustScore`
- **RFQ (HCS-18)** — `createRfqBoard`, `rfqAnnounce`, `rfqPropose`, `rfqRespond`, `rfqComplete`, `rfqWithdraw`, `rfqList`
- **Flora (HCS-16)** — `createFlora`, `floraChat`, `floraRead`, `ensureChatRoom`, `auditorReply`
- **Profile (HCS-11)** — `createProfile`
- **Reputation (HCS-20)** — `reputationDeploy`, `reputationMint`, `reputationTransfer`, `reputationBurn`, `reputationBalance`, `reputationVotingDeploy`, `voteGood`, `voteBad`, `removeVote`, `reputationScore`
- **Reviews** — `createReviewBoard`, `postReview`, `listReviews`
- **Orchestration** — `initMars`, `getMars`, `saveMars`, `registerAgent`, `startJob`, `updateJob`, `logHumanVerified`
- **Audit flow** — `createAuditTrail`, `auditStep`, `auditVerdict`, `createTask`, `runAudit`, `finalizeTask`, `publishPremiumSkill`, `scheduleReAudit`

`POST /api/hederaone/register-agent-stream` is separate — it streams registration progress
(SSE-style) so the UI can show steps live, including the World ID AgentBook verification
link.

### The end-to-end flow

`createAccount` → `initMars` (bootstraps the registries) → `registerAgent` →
`createTask` → `runAudit` → `finalizeTask` → `publishPremiumSkill`.

`/hederaone/hedera` drives exactly this, in order. Read the page top to bottom and you have
the tour.

`maxDuration` on the route is 300s because `runAudit` runs four LLM stages plus several
HCS writes.

---

## 4. Gotchas

- **Testnet keys in responses.** `createAccount` on both sides returns the new private key
  as JSON. Fine for a testnet demo, unacceptable anywhere else. If any of this goes to
  mainnet, that has to change first.
- **Always `client.close()`.** Missing it leaves the gRPC connection open and Node will not
  exit. The routes do it; your own code must too.
- **The Mirror Node lags.** It is eventually consistent, roughly a few seconds behind
  consensus. Writing then immediately reading back can return nothing — that is expected,
  not a bug. Retry.
- **Operator pays for everything.** There is no per-user fee-payer wiring here. Every
  transaction is billed to `HEDERA_OPERATOR_ID`.
- **`hedera-state.json` is the hedera2 demo's state**, checked in at the repo root, with
  live topic IDs from the original hackathon run. Delete it and re-bootstrap if you want a
  clean slate.
- **Some hederaone actions need files we did not copy.** `createTask` with a `skillRef` reads
  from a `demo/skills/` folder, and `state.ts` writes `mars-state.json` — neither exists
  here. Pass `content` inline to `createTask` to bypass the folder; `mars-state.json` is
  created on first write.
- **Two dependencies come along for the ride**: `@worldcoin/agentkit` (hederaone's anti-sybil
  check) and `qrcode.react` (the verification QR on the hederaone page).

## 5. Files

```
lib/hederaone/            hedera.ts + support (agents, agentbook, state, encrypt,
                       world-agentkit, demo-skills*, auditor, audit-task,
                       audit-core.mjs, db.mjs, skill-source.mjs)
lib/hedera2/        hedera.ts, hcs-standards.ts, agent-helpers.ts
pages/hederaone/          hedera.tsx
pages/hedera2/      hedera.tsx
pages/api/hederaone/      hedera.ts, register-agent-stream.ts
pages/api/hedera2/  hedera/ (5 routes), hcs/ (6 routes)
hedera-state.json      hedera2 demo state
docs/hedera-usages.md  upstream index of where each standard is used
```
