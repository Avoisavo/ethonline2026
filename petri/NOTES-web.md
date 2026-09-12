# NOTES-web — the tree viewer and the JSON it eats

Owner of `web/`. Nothing here changes `src/`, `bench/` or `harness/`.

`web/index.html` is one file. It has no build step, no npm package and no CDN link.
All CSS and all JavaScript are inline. Open it with `file://` and it works.

---

## 1. The command that feeds the page

```
pnpm petri export --out web/tree.json
```

`petri export` is already in the binding contract, SPEC §14.5:

> `petri export` — `--out <file>` — Write the whole tree as one JSON document,
> with `trust` and `mode` at the top level.

The page reads that document. Section 3 below is the exact shape it expects.

### 1.1 How the page finds the data

The page tries three sources, in this order. The first one that works wins.

1. A `?data=<url>` query parameter. Use it to point at a tree on a static host.
2. `tree.json` beside the page. `petri export --out web/tree.json` writes it there.
3. The sample dataset embedded in the page, in
   `<script type="application/json" id="petri-sample">`.

Source 1 and source 2 need `fetch`, which a `file://` page blocks. So a page opened
straight from disk falls back to source 3 and still shows a real tree. The header
says which source is live. Serve the directory (`python3 -m http.server`) to read a
real export from disk.

### 1.2 Why the page never reads `.petri/` itself

A browser cannot read a directory. More important: the harness must never be able to
read the benchmark test files (design rule 5), and a viewer that walks the repo is
one more path into that. The viewer reads one export file and nothing else.

---

## 2. Rules the page has to obey, and how it does

| Rule | How the page keeps it |
|---|---|
| Rejected nodes are first-class records (rule 3) | A rejected node is the same size, the same type scale and the same click target as an accepted one. No filter hides it by default. No branch collapses by default. The failed hypothesis is on the row, not behind a click. |
| A contributor never verifies their own node (rule 1) | Each verification card says `COUNTED` or `IGNORED`, and an ignored one prints the reason verbatim, including `self-verification: the signer is the node author`. Duplicate votes from one key print `one key is one vote`. |
| Median over N runs (rule 2) | The node panel shows all N runs per side, and marks the median run. Nothing on the page ever shows a mean. |
| Every node states a hypothesis (rule 4) | The hypothesis is the row's main text. It is never truncated in the panel. |
| Mode is stated honestly (SPEC §8.9) | `mode` and `trust` appear as a banner at the top and as a badge on every node row and every verification card. A `replay` node carries the `REPLAY` badge everywhere it appears. |
| Claims are not votes (SPEC §6.4) | The author's `claimedRuns` are labelled `author claim — never counts toward acceptance`. The verified delta is a separate, differently styled number. |

Accepted versus rejected is legible with no colour at all:

| Status | Glyph | Left rule | Weight | Text code |
|---|---|---|---|---|
| accepted | `●` filled disc | solid | bold | `WIN`, `ROOT_BASELINE` |
| rejected | `✕` | dashed | regular | `REGRESSION`, `WITHIN_NOISE`, `NOT_CLEAN` |
| pending | `◇` hollow diamond | dotted | regular | `INSUFFICIENT_VERIFICATIONS`, `RUNS_TOO_NOISY`, `RUNNERS_DISAGREE` |
| contested | `▲` | double | regular | `CONTESTED` |
| mechanical failure | `⊘` | dotted | regular | the `mechanical.cls` string |
| withdrawn / superseded | `⊝` | dotted | regular, struck | `WITHDRAWN`, `SUPERSEDED` |

Colour is added on top of that. Remove the colour and every distinction survives.

---

## 3. The export shape — `petri/export/1`

Display document. **It is never hashed and never signed**, so §2 of the contract does
not bind it: `null` is allowed here and is used for "not computable". Every id is
bare Hex64 (§1.1). Every score is basis points. Every duration is milliseconds.

```ts
interface PetriExport {
  protocol: 'petri/export/1';
  generatedAt: number;          // unix ms, when the export ran
  cli: string;                  // e.g. "petri 0.1.0"
  tree: string;                 // TreeId
  mode: 'live' | 'replay';      // the tree config mode. SPEC §8.9 wants it top level
  trust: 'hcs' | 'local-unverified';   // SPEC §8.9
  ledger: {
    kind: 'hcs' | 'local';
    lastSeq: number;
    headHash: string;           // Hex64 local chain head, '' for hcs
    topicId: string;            // '' when local
    network: string;            // '' when local
  };
  bench: { id: string; name: string; total: number };  // total = task count
  policy: Policy;               // SPEC §4, verbatim
  runsPerVerification: number;
  runners: RunnerRow[];
  stats: Stats;
  nodes: ExportNode[];          // ordered by seq, ascending
}

interface RunnerRow {
  pub: string;      // Hex64 ed25519 public key. The key IS the identity (§1)
  label: string;    // self-claimed machine name. NOT verified. The page says so
  note: string;     // free text, e.g. "Apple M2, macOS 15"
  reports: number;  // how many reports this key signed in this tree
}

interface Stats {
  total: number;
  accepted: number; rejected: number; pending: number;
  contested: number; withdrawn: number; superseded: number;
  head: string;     // node id of the accepted node with the best claimed median
  tips: string[];   // accepted nodes with no accepted child. The live frontiers
}

interface ExportNode {
  id: string;              // Hex64 node id = contentId(manifest)
  short: string;           // id.slice(0, 8). Convenience only
  label: string;           // short human handle, e.g. "n013". Display only
  seq: number;             // log sequence of its NodeSubmitted
  consensusNanos: string;  // decimal string. A number would lose precision
  parent: string;          // Hex64, or the literal 'root'
  tree: string;
  author: string;          // Hex64. From the FIRST NodeSubmitted envelope pub
  authorLabel: string;     // self-claimed, unverified
  harness: string;         // Hex64 harness id
  bench: string;           // Hex64 bench id
  hypothesis: string;      // manifest.hypothesis, one trimmed line
  status: NodeStatus;      // SPEC §6.10. Derived on load, never stored
  statusCode: DecisionCode;// SPEC §9.2
  statusReason: string;    // plain English, straight from evaluate()
  verifiedDeltaBp: number | null;   // null when it could not be computed
  disputed: boolean;
  mode: 'live' | 'replay';
  trust: 'hcs' | 'local-unverified';
  detail: ExportDetail;
  diff: string;            // unified diff against the parent snapshot. DISPLAY ONLY
  verifications: ExportVerification[];
  costs: { medianTokens: number; medianWallMs: number; tokensPerTask: number };
}

interface ExportDetail {
  proposal: {
    hypothesis: string; falsifiedIf: string;
    primaryArea: string;          // DECLARED by the proposer
    motif: string; metric: 'score' | 'tokens'; predictedDelta: number;
    reasoning: string;
    whyNotUntested: string | null;
    contradicts: { nodeId: string; why: string }[];
    files: { path: string; bytes: number }[];   // contents omitted, see below
  };
  derivedAreas: string[];   // from the diff classifier, SPEC §12.1. This one wins
  areaMismatch: boolean;    // declared !== derived. The page flags it
  claimedRuns: { passed: number; scoreBp: number; tokens: number; wallMs: number }[];
  claimedMedianBp: number;
  parentHarness: string;    // Hex64, EMPTY_HARNESS_ID for a root
  provenance: { source: 'model' | 'human' | 'model-via-human'; model: string;
                promptHash: string; digestHash: string; seed: number };
  mechanical: { cls: string; command: string; exitCode: number; evidence: string };
}

interface ExportVerification {
  reportId: string;      // Hex64 contentId(report)
  runner: string;        // Hex64 — the ENVELOPE pub, never report.runner (§5.3)
  runnerLabel: string;   // self-claimed, unverified
  sig: string;           // 128 hex
  counted: boolean;      // did evaluate() count this one
  ignoredWhy: string;    // '' when counted, else the verbatim reason from Verdict.ignored
  mode: 'live' | 'replay';
  runs: number;          // odd, >= 3
  clean: boolean;
  spreadBp: number;      // max - min of candidate.runs[].scoreBp
  deltaMedianBp: number; // median of the PAIRED per-run deltas
  seedBase: string;      // Hex64
  startedAt: number;     // unix ms
  parent:    { node: string; medianBp: number; total: number; runs: RunRecord[] };
  candidate: { node: string; medianBp: number; total: number; runs: RunRecord[] };
  env: EnvDescriptor;    // SPEC §6.5, verbatim
}
```

`RunRecord` and `EnvDescriptor` are copied from SPEC §6.5 with no change.

### 3.1 Three deliberate choices

1. **`proposal.files` carries `path` and `bytes`, not `contents`.** The full source
   lives in the object store. The page renders `diff`, which is what a reader wants.
   Carrying both would roughly double the export for no gain.
2. **`costs` is precomputed.** `medianTokens`, `medianWallMs` and `tokensPerTask` are
   medians of the author's claimed runs. The page must never take a mean, so the
   exporter takes the median once and the page never does arithmetic on runs.
3. **`counted` and `ignoredWhy` are copied from `Verdict`, not recomputed.**
   `evaluate()` in `src/policy/acceptance.ts` is the one source of truth. A viewer
   that re-derives acceptance would be a second implementation of the accept rule,
   and the first thing to drift.

### 3.2 What the exporter must not do

- Do not drop rejected, contested, withdrawn or superseded nodes. Rule 3.
- Do not sum tokens across runs. Median only. SPEC §10.9.
- Do not fill `runnerLabel` or `authorLabel` from anything but the self-claimed
  identity label. They are decoration. The Hex64 key is the identity.
- Do not put a status inside the node record on disk. Status is derived on load
  (SPEC §6.10); the export is a snapshot of that derivation, stamped `generatedAt`.

---

## 4. The embedded sample dataset

The page ships with a 23-node sample tree so it shows something real the moment it
opens. It is generated, not hand-typed, and it is internally consistent with the
contract:

- 20 bench tasks, so every `scoreBp` is a multiple of 500 (SPEC §10.8).
- The win margin is 1000bp, which is 2 tasks out of 20 (SPEC §4.1).
- 5 accepted, 12 rejected, 5 pending, 1 contested.
- Every status was hand-checked against the case table in SPEC §9.7. The set covers
  `ROOT_BASELINE`, `WIN`, `REGRESSION`, `WITHIN_NOISE`, `NOT_CLEAN`, `CONTESTED`,
  `RUNS_TOO_NOISY`, `RUNNERS_DISAGREE` and `INSUFFICIENT_VERIFICATIONS`.
- It carries one ignored self-verification, one ignored duplicate vote from a key
  that already voted, one ignored cross-mode report, two typecheck failures and one
  malformed proposal.
- One node was measured in `live` mode inside a `replay` tree, so the mode badge has
  something to distinguish.

The sample is marked `SAMPLE DATA` in the header whenever it is the live source. The
signatures and keys in it are generated bytes. They verify nothing.

The generator is authoring-time only and is not part of the repo. Regenerate the
sample by replacing the JSON inside `<script type="application/json" id="petri-sample">`
with the output of a real `petri export`.

---

## 5. Open seams for whoever writes `petri export`

1. `petri export` has no `src/cli/export.ts` yet. Section 3 is the shape to write.
2. `ExportNode.label` (`n000`, `n013`) has no source in the contract. Suggestion:
   assign it from `seq` at export time, as `n` plus the zero-padded sequence index of
   the node's `NodeSubmitted`. It is display only and must never enter a hash.
3. `Verdict.ignored` gives `{ pub, why }`. The exporter has to join that onto the
   verification list by `pub` to fill `counted` and `ignoredWhy`.
4. `spreadBp` and `clean` live on the `VerificationSigned` wire message (SPEC §8.3),
   not on `VerificationReport`. The exporter reads them from the log entry.
