# Petri

Petri is a version tree for AI agent harnesses. Every node carries a plain-English
hypothesis, a measured score, and signatures from machines that re-ran the measurement.

---

## The problem

**1. Nobody measures.** Teams change a prompt, a retry rule or a retrieval order. Then
they say the agent "feels better". There is no number, no baseline and no repeat count.

**2. Failures stay private.** A dead end lives in one person's terminal history. The
next engineer tries the same idea. The team pays for the same tokens twice.

**3. Nobody can check a claim.** A blog post reports a 12% gain. You cannot re-run it.
You cannot see the harness. You cannot tell if the author measured once or fifty times.

---

## What Petri is

Petri is a git where every commit carries an independently verified measurement, and
where nothing is ever deleted.

A commit in Petri is a **node**. The node id is the SHA-256 of the manifest below. The
manifest is immutable. Change one byte and you get a different node.

This is a real file from this repo, at
`.petri/nodes/6c/9c2b06.../manifest.json`:

```json
{
  "author": "405c7caa7c57406121fa15e4da53f9df5018a71aa4cec92a8550bd8fc1b088ca",
  "bench": "5ec2e9b81f7ab85dc999eb179bd1d38ad7f89e4670706b2a6f14cd830b136ed2",
  "detail": "8b5bb6b665c97e5417fd6402db51cb299155768e250d6de1231aea4c4d58f653",
  "harness": "de5f72c42e8b728c293ce666175c97f8bc15a29c3f6ca21ac14155b109c5bcbf",
  "hypothesis": "Giving the model the full symbol signatures and one worked example of the reply shape raises the pass rate, because most failures are wrong shape, not wrong logic.",
  "nonce": "",
  "parent": "df97ac394293a413f350ae9c731ec46161d2547552ce5cfbf68331c7b6738228",
  "protocol": "petri/node/1",
  "tree": "petri-main"
}
```

Read each field once:

| Field | Meaning |
|---|---|
| `parent` | The node this one changed. `"root"` for the first node of a tree. |
| `author` | The ed25519 public key that proposed it. The key is the identity. There is no registry. |
| `harness` | The content id of the harness source files. Six TypeScript files here. |
| `bench` | The content id of the benchmark. It pins which tests produced the score. |
| `detail` | The content id of the evidence bundle: the diff, the author's own runs, the typecheck result. |
| `hypothesis` | Plain English, at most 240 bytes. A node without one cannot be built. |

The author's own runs sit in the detail. **They never count toward acceptance.** They
are a claim, not a vote.

A separate record holds each verification. This is a real one, from
`.petri/nodes/6c/9c2b06.../verifications/86e0b76b....json`:

```json
{
  "bench": "5ec2e9b81f7ab85dc999eb179bd1d38ad7f89e4670706b2a6f14cd830b136ed2",
  "candidate": {
    "medianBp": 9500,
    "node": "6c9c2b06393f05e1967cb519f5aa07ab06658de50da14479506c8951722713cf",
    "runs": [
      { "passed": 19, "scoreBp": 9500, "tokens": 22831, "wallMs": 1078,
        "seed": "006c880152cf9878c9a802d8f7f4e186e094a10889ac00e6c4b04d10dcaed357",
        "resultId": "a304be9710d299970aa68d6da41b03496323618271cfda81ceac0e2d1d7dbbba" }
    ],
    "total": 20
  },
  "deltaMedianBp": 7000,
  "env": { "arch": "arm64", "ledger": "local", "mode": "replay",
           "model": "none", "nodeVersion": "v26.0.0" }
}
```

Four rules control the record:

1. A verifier runs **both sides**, the parent and the candidate. An absolute score is
   worthless on its own. Only the paired delta travels between machines.
2. A verifier runs each side 5 times and reports the **median**. One run is noise.
3. The seeds derive from the candidate node id. Two honest verifiers get the same seeds.
4. The report is signed. The signer key comes from the envelope, never from the body.

A node reaches `accepted` when 2 verifications from 2 different keys both report a
delta at or above +1000 basis points. A node reaches `rejected` when both report at or
below -1000 basis points. Anything between those bands is `rejected` as a tie.

---

## Why this is evolution

| Evolution | What the code does |
|---|---|
| **Variation** | One node changes at most 2 files and at most 120 lines of the parent harness. `src/evolve/guards.ts` refuses a bigger patch. `harness/contract.ts` is frozen and can never change. |
| **Inheritance** | A node names its `parent`. The child starts from the parent harness snapshot, not from the repo working tree. |
| **Selection** | `src/policy/acceptance.ts` is a pure function. It reads no clock and uses no randomness. It reads the signed deltas and returns `accepted`, `rejected`, `contested` or `pending`. |

Petri improves on nature in one place. **Nature discards failures.** A lineage that
dies leaves nothing behind, so the next lineage can repeat the same mistake.

Petri keeps failures as first-class records. A rejected node keeps its hypothesis, its
diff, its score and its signatures, forever. `petri dead-ends` prints them:

```
b7650d0c  rejected  REGRESSION  prompt/drop-signatures  -7000bp
  "Dropping the signatures and the worked example from the prompt saves input tokens
   without losing accuracy, because the symbol names alone should be enough."
  2 independent verifications, every one at or below -1000bp. Best delta -7000bp.

1 recorded failures. None of them was deleted.
```

---

## Why an AI can use it

Two features make the tree machine-readable.

**The hypothesis field.** Every node states, in one line, what the author believed and
why. A score alone tells an agent that something worked. A hypothesis tells it what
idea worked, so the agent can reuse the idea and not the diff.

**The tree digest.** `petri digest` flattens the whole tree into one prompt-sized
document. It names what won, what lost, and which areas nobody has tried.

This is the real output of `pnpm petri digest` in this repo:

```
# PETRI DIGEST  ledger 3 nodes  digest-hash ce3548a6
bench petri-bench-v1 5ec2e9b8 | 20 tasks | unit tests only | N=5 runs | MEDIAN
mode REPLAY (deterministic, no API key). REPLAY never compares against LIVE.
ledger LOCAL — UNVERIFIED. See the trust banner.
totals: 1 accepted | 1 rejected | 1 pending | 0 contested
head n001 9500bp | root n000 0bp | lift +9500bp over 1 accepted steps

## 1. ACCEPTED SPINE
id    area      motif                    score    delta  tok/task   hypothesis
n000  -         genesis-v1                 0bp        -         -  Single-shot prompt. No retry. No test run.
                                                                   This is the honest baseline.
n001  prompt    signatures-and-example  9500bp   +7000bp       1.1k  Giving the model the full symbol
                                                                     signatures and one worked example of the
                                                                     reply shape raises the pass rate, because
                                                                     most failures are wrong shape, not wrong
                                                                     logic.

## 2. AREA MAP
area           tried   acc  rej  pend  contest best delta   best node  verdict
prompt             2    1    1     0        0    +7000bp   n001       PRODUCTIVE
retrieval          0    0    0     0        0          -   -          NEVER TRIED
recovery           0    0    0     0        0          -   -          NEVER TRIED
loop               0    0    0     0        0          -   -          NEVER TRIED
decoding           0    0    0     0        0          -   -          NEVER TRIED
budget             0    0    0     0        0          -   -          NEVER TRIED
verification       0    0    0     0        0          -   -          NEVER TRIED
decomposition      0    0    0     0        0          -   -          NEVER TRIED
memory             0    0    0     0        0          -   -          NEVER TRIED
other              0    0    0     0        0          -   -          NEVER TRIED

## 3. AREA DETAIL

### prompt  PRODUCTIVE  2 tried / 1 accepted / 1 rejected
  best     n001 +7000bp motif signatures-and-example
  motifs   signatures-and-example 1/1 acc | drop-signatures 0/1

## 4. NEVER TRIED  (no node has touched these)
retrieval      What task material enters the prompt, and in what order.
               probes: ranking, truncation, file selection
recovery       What the harness does after a bad reply.
               probes: repair turns, error text feedback, fallbacks
loop           The control flow of one solve call.
               probes: step count, stop rule, reply parsing
decoding       Sampling controls on each model call.
               probes: temperature, maxTokens, stop sequences
budget         How the harness spends calls and tokens.
               probes: per-step caps, reserve for repair
verification   Checks the harness runs on its own answer before it returns.
               probes: invariant checks, self-review pass, shape checks
decomposition  Splitting one task into smaller model calls.
               probes: plan then write, one call per symbol, sub-agents
memory         State carried across steps inside one solve call.
               probes: scratchpad, reuse of earlier drafts
               LIMIT: ctx is fresh per task. Cross-task memory needs a contract change. The contract is
                      frozen, so it is out of scope.
other          Anything the registry does not name.

## 5. NOTABLE FAILURES  (hypotheses quoted verbatim)

n002  prompt / drop-signatures    rejected REGRESSION -7000bp (9500 -> 2500), tok -278
> "Dropping the signatures and the worked example from the prompt saves input tokens without losing accuracy,
>  because the symbol names alone should be enough."

## 8. CONSTRAINTS FOR NODE N+1
parent n001 | 9500bp | 1.1k tok/task | budget maxCalls 8, maxTokens 120000
at most 2 files changed, at most 120 changed lines
harness/contract.ts is immutable. solve() keeps its signature.
imports: relative siblings inside harness/ only
the win margin is 1000bp. A smaller measured gain is recorded as a tie.
a SATURATED area needs whyNotUntested. An exhausted motif needs contradicts.
known motif slugs (reuse one if it fits):
  signatures-and-example, drop-signatures
```

Section 4 is the part a normal git cannot produce. It lists work nobody has done. An
agent reads it and spends its next node where the tree holds no information.

---

## Why it must be decentralised

The value of Petri is not in the storage. The value is in **not trusting the
submitter**.

An author states a score. A central server that accepts that score adds nothing. The
author could have run the benchmark once, or zero times, and reported the best number.

So Petri moves three things out of the author's control:

1. **The measurement.** The author's own runs never count. Two other keys must re-run
   both sides and sign the result.
2. **The refusal.** `petri verify` compares the node author key against your own key.
   It exits 4 before it runs anything. `evaluate` drops a self-signed report a second
   time, at counting time.
3. **The record.** Every node and every report goes to a consensus log as a signed
   message. With `ledger: hcs`, that log is a Hedera Consensus Service topic created
   with **no admin key and no submit key**. Nobody can edit it or delete it, including
   the person who created it.

A default install uses `ledger: local`, which is a signed hash chain in
`.petri/log.jsonl`. Every command prints a banner that says what the local log does not
prove. There is no flag to hide the banner:

```
TRUST  local log <your checkout>/.petri/log.jsonl  —  UNVERIFIED
  This log is on this machine only. It proves nothing about independence.
  One person can hold every key in it. The file can be edited or deleted.
  Only a Hedera topic proves order, time and non-deletion to a stranger.
  Run `petri topic create` to publish to a real topic.
MODE   replay  —  this is NOT a new measurement
  Replay re-runs recorded harness outputs through the real sandbox.
  The tests genuinely execute. The harness does not call a model.
  A replay number can never be compared against a live number.
```

---

## Quickstart

You need Node 22 or later and pnpm. You need **no API key and no Hedera account**.

This sequence takes about 15 seconds after install. Every line below is real output.

**1. Install.**

```bash
pnpm install
```

**2. Create your own key.** The repo ships the tree but never the private key.
`.petri/identity.json` is in `.gitignore`.

```bash
pnpm petri id create --label judge
```

**3. Read the tree.** The repo ships 3 nodes in `.petri/`.

```bash
pnpm petri tree
```

```
df97ac39  pending    delta -             verifiers 0   mode replay  trust local-unverified
    Single-shot prompt. No retry. No test run. This is the honest baseline.
    INSUFFICIENT_VERIFICATIONS: 0 of 2 independent verifications. The author's own runs never count.
  6c9c2b06  accepted   delta +7000bp       verifiers 3   mode replay  trust local-unverified
      Giving the model the full symbol signatures and one worked example of the reply shape raises the pass rate, because most failures are wrong shape, not wrong logic.
      WIN: 2 independent verifications, every one at or above +1000bp. Worst delta +7000bp. This is a real improvement.
    b7650d0c  rejected   delta -7000bp       verifiers 2   mode replay  trust local-unverified
        Dropping the signatures and the worked example from the prompt saves input tokens without losing accuracy, because the symbol names alone should be enough.
        REGRESSION: 2 independent verifications, every one at or below -1000bp. Best delta -7000bp. This is a measured regression. The change makes the harness worse.

3 nodes: 1 accepted, 1 rejected, 1 pending, 0 contested, 0 other
Rejected branches stay here forever. That is design rule 3.
```

**4. Run the acceptance rule yourself.** This re-runs both sides, 5 times each, in a
child process with the Node permission model on. It takes about 12 seconds.

```bash
pnpm petri verify 6c9c2b06393f05e1967cb519f5aa07ab06658de50da14479506c8951722713cf
```

```
verifying 6c9c2b06 against df97ac39  (5 runs a side)
report     a1bf089350a1d6d0e2abc44833a12569e2e2cc0d3268d7311a387bf7b4a4c668
runner     e9f260802d5f5cbeab900eec5e952783d08355f7d15fb628117cc5909ce561e1
parent     df97ac39  median 2500bp
candidate  6c9c2b06  median 9500bp
delta      +7000bp  (median of 5 paired deltas)
spread     0bp over the candidate runs
clean      yes
published  seq 9
```

The `runner` line shows your own key, so your value will differ. The two medians, the
delta and the spread are identical on every machine, because replay mode is
deterministic and the seeds derive from the node id.

**5. Read the digest an agent would read.**

```bash
pnpm petri digest
```

**6. See that failures stay.**

```bash
pnpm petri dead-ends
```

**7. See the self-verification refusal.** The author of a node cannot verify it. Run
this from the checkout that created the tree, where your key is the author key:

```bash
pnpm petri verify 6c9c2b06393f05e1967cb519f5aa07ab06658de50da14479506c8951722713cf
# petri: you are the author of 6c9c2b06. You cannot verify your own node.
# exit 4
```

### Upgrade path 1: a live model

Set `ANTHROPIC_API_KEY` in `.env` and run with `--mode live`. The harness then calls a
real model through `src/model/anthropic.ts` instead of replaying recorded answers.

A live score and a replay score can never be compared. The ban is enforced in
`evaluate`, in `checkReport` and in the digest header.

### Upgrade path 2: a real Hedera topic

Set `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` in `.env`, then run:

```bash
pnpm petri topic create --network testnet
```

Petri creates a topic with no admin key and no submit key, and writes the topic id into
`.petri/config.json`. Every later node and report goes to that topic. The trust banner
changes to `PUBLIC`. Testnet HBAR is free from the Hedera portal faucet.

---

## Petri and git

| | git | Petri |
|---|---|---|
| Unit | A commit | A node |
| Commit id covers | A tree of files | A harness, a benchmark, a hypothesis and an evidence bundle |
| Who decides a change is good | A human reviewer reads a diff | A pure function reads signed measurements |
| Evidence attached | A message the author wrote | 5 paired runs per verifier, with per-run seeds and result hashes |
| Can the author merge their own work | Yes | No. Exit 4 at signing, and dropped again at counting |
| Deleting history | `git rebase`, `git push --force`, `git gc` | No delete path. A rejected node keeps its hypothesis and its score |
| Failed work | Usually never pushed | A first-class record. `petri dead-ends` lists it |
| Machine-readable summary | `git log` lists what happened | `petri digest` lists what worked, what failed, and what nobody tried |
| Ordering authority | Whoever holds the remote | A hash chain, or a Hedera topic with no admin key |

---

## What this does NOT prove

Every item below is reproducible in the code as it stands today.

### The trust model has real holes

**A lazy verifier can sign without running anything.** Petri never proves that a
verifier executed the benchmark. A verifier can copy the author's numbers, sign them
and publish. The signature is valid and the acceptance rule counts the report.

In replay mode the seeds are deterministic, so two honest verifiers must produce
identical per-run `resultId` values. SPEC section 18.1 assigns that check to
`petri replay --audit`. **That command does not exist in this build.** Nothing in the
shipped CLI compares result hashes across verifiers. In live mode the check is
impossible anyway, because model sampling makes honest runs differ.

**Local-log mode proves nothing about independence.** One person can create any number
of keys. `src/store/paths.ts` documents the mechanism and ships it on purpose:

```
PETRI_HOME moves this ONE file, and nothing else. Set it to give a second
process on this machine a second identity against the SAME tree.
```

Two shell commands clear the default 2-verification bar alone. Petri's own banner says
so. The verdict string does not: `evaluate` writes "2 independent verifications"
without any test of independence. A Hedera topic does not fix this either. It proves
two accounts paid. It does not prove two people exist.

**A key allowlist is the only real defence, and it is off.** Set
`policy.trustedRunners` to turn a permissionless tree into a curated one.

**There is no key revocation.** `.petri/identity.json` holds an unencrypted seed at
mode 0600. A stolen key's past signatures stay valid forever.

### Defects found by audit and confirmed

**The genesis node can never be verified.** `src/cli/verify.ts:121-122` sets the parent
side of a root node to the empty harness `{}`. `bench/src/runner.ts` then needs an
`index.ts` that does not exist:

```
$ petri verify <genesis node id>
petri: petri bench: no harness entry point at
       .../.petri/scratch/harness/58940959…/harness/index.ts
```

So the genesis node stays `pending` forever, and the sandbox canary just below that
line is unreachable code. Child nodes verify correctly, because their parent is a real
harness. The accepted and rejected nodes in this repo prove that path works.

**The printed verifier count is wrong.** The acceptance rule collapses duplicate keys
correctly, in all three places that count votes. The status line does not. It prints
`node.verifications.length`, which is the raw file count, including duplicates from one
key and including the author's own report. You will see lines like:

```
6c9c2b06  accepted   delta +7000bp       verifiers 3   ...
  WIN: 2 independent verifications, every one at or above +1000bp.
```

The rule counted 2. The display said 3. **Trust the reason string, not the count.**

**Node ids are not reproducible across machines.** SPEC section 3 promises a content id.
The canonical JSON encoder in `src/core/canonical.ts` is sound, but the payload it
hashes carries three local values:

1. `ClaimedRun.wallMs` is raw `Date.now()` arithmetic from `bench/src/runner.ts`. It
   sits in `NodeDetail.claimedRuns`, which the node id commits to. Two machines that
   run the identical patch always get two different node ids.
2. `MechanicalResult.command` and `.evidence` hold verbatim `tsc` output and the command
   line. Those carry the user's home directory and a fresh `randomUUID` per run. A
   typecheck-failed node hashes differently twice on one machine.
3. `Provenance.digestHash` is a hash of the whole materialised tree, including nodes
   that are on disk but absent from the log.

**Absolute paths are gone.** `src/core/root.ts` derives `REPO_ROOT` from the location
of the file itself, and every other module reads it from there. `src/store/paths.ts`
builds every path under `.petri/` from the tree root, so `--root <dir>` now moves the
config, the identity, the objects, the nodes and the log together. Two trees on one
machine no longer share a log file.

### Replay mode covers exactly two harnesses

Replay mode does not call a model. It replays recorded answers. This repo ships
fixtures for exactly two harness ids: the genesis harness and the accepted child. A
third harness edit has no fixture, and `petri submit` refuses with a clear error:

```
  path     .../bench/fixtures/c276d279…/09-lru-cache/0.json
  Replay mode never calls a model, so it cannot invent this answer.
  Fix it in one of three ways:
    1. allow the published graded answers:  add --allow-graded
    2. measure this harness live, which calls the model for real:
       ANTHROPIC_API_KEY=... pnpm petri verify <nodeId> --mode live
    3. measure a harness the fixture store already holds:
    6666aa69455499737042e676fd082a9978c92fb50ef7d845c1c63ef5e7018da3
    de5f72c42e8b728c293ce666175c97f8bc15a29c3f6ca21ac14155b109c5bcbf
```

One of those three remedies does not work in this build.
`--allow-graded` is not a `petri submit` flag, and it reads
`bench/tasks/<id>/answers/<grade>.mjs`. All 20 `answers/` directories exist and all 20
are empty. `bench/RULES.md`, which `src/model/replay.ts` says the graded client must
publish, does not exist either.

So a new harness needs an `ANTHROPIC_API_KEY` and a live run before replay mode can
score it. Design rule 6 holds for reading and verifying the shipped tree. It does not
hold for extending the tree offline.

### Commands in the spec that this build does not have

`petri fsck` and `petri export` are registered and work. These are specified and
still absent: `evolve`, `bench *`, `log`, `replay`, `selftest` and `demo`. No command
that this build does not have is named in any message it prints.

**`pnpm demo` fails with exit 1.** SPEC section 14.7 calls `petri demo` "the judge's
path". The quickstart above replaces it with real commands.

The absent `evolve` command matters most. Without it, no model proposes a node. Every
node in this tree was proposed by a human through `petri propose` and `petri submit`.

### The sandbox is partial

The solution and the tests share one process, because the Node permission model is
process-wide. A solution cannot read `test.mjs` from disk. It can still reach the tests
in memory, or patch `node:assert`.

Petri counts passes from the `node:test` event stream, not from assertion side effects,
which defeats naive patching. It flags any disagreement between the exit code and the
attestations as `tampered`. **A determined in-process attack is not blocked.** The real
fix is one process per task, or an OS container. Both were rejected, so a judge can
clone and run with no setup.

### The benchmark is 20 tasks

A node can improve these 20 tests and nothing else. Every verification stays honest and
the recorded gain still may not generalise. There is no held-out split. The bench id at
least pins which tests produced a score, so a reader can see what was optimised.

### Live mode is not deterministic

Model sampling and provider routing change scores between two honest runs. A median
over 5 runs reduces the noise. It does not remove it. A provider change months later
can make an accepted node wrong while the tree still says `accepted`. Petri has no
re-validation message type.

---

## Repository map

| Path | Holds |
|---|---|
| `SPEC.md` | The binding contract, 3976 lines. Where code and spec disagree, the spec is right and the code is wrong. |
| `src/core/` | Canonical JSON, SHA-256, content ids, every shared schema |
| `src/trust/` | ed25519 identity, signed envelopes, the verification report |
| `src/consensus/` | The log: the local hash chain, the Hedera topic, the mirror reader, the replay reducer |
| `src/policy/acceptance.ts` | `evaluate`. The pure acceptance rule |
| `src/store/` | Everything under `.petri/`. The only module that builds those paths |
| `src/evolve/` | Guards, the diff, the scratch typecheck, `runCandidate` |
| `src/flatten/` | Areas, the digest model, the digest renderer |
| `src/cli/` | The commander entry point and every registered command |
| `bench/` | 20 tasks, the sandbox, the runner, the median, the recorded fixtures |
| `harness/` | The 6 harness files under evolution. `contract.ts` is frozen |
| `test/` | 62 tests. `pnpm test` passes. `pnpm typecheck` exits 0 |
| `web/` | One static page. It tries to load `tree.json` and falls back to a built-in 23-node sample. Run `pnpm petri export --out web/tree.json`, then serve the directory, and the page shows the real tree |

`test/golden.test.ts`, `test/accept.test.ts` and `test/sandbox.test.ts` are specified in
SPEC section 15 and do not exist.
