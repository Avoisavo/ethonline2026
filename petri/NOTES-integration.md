# Integration notes

Ten agents wrote this repo in parallel against SPEC.md. This file records only the
decisions the integration pass had to make, because SPEC.md did not settle them.
Where SPEC.md did settle a question, SPEC.md won and nothing is recorded here.

## 1. `medianOf` keeps the two-argument shape of its owner module

SPEC.md section 15 gives `medianOf` to `bench/src/median.ts` but states no signature.
Its two callers each passed one configuration object, and the two objects disagreed:
`src/cli/measure.ts` passed a `BenchSpec` and a `HarnessSnapshot`, while
`src/evolve/run.ts` passed a bench id string and a harness directory. Neither shape
had more call sites than the other.

Decision: `medianOf(attempt, input)` stays. The module's own contract says the caller
supplies the attempt, so the function is the same in live mode and in replay mode and
a test can drive it with no child process. Both callers now build the attempt from
`runOnce`.

## 2. The missing seam: a harness snapshot has to become a `solve` function

Both `medianOf` callers assumed some module turned a harness into a runnable entry
point. No module did. `bench/src/runner.ts`, which already owns `SolveFn` and
`runOnce`, now owns two new exports:

- `materialiseHarness(snapshot, dir)` writes a snapshot to disk.
- `loadSolve(harnessDir)` imports `index.ts` and returns its `solve`.

`loadSolve` imports the entry point and nothing else, so the harness still receives
only what `TaskView` carries. Design rule 5 holds.

`src/store/paths.ts` gained `scratchHarnessRoot(harnessId)`. No other module builds a
path under `.petri/`.

## 3. The report record types are declared once, in `src/core/schema.ts`

`src/core/schema.ts` and `src/trust/report.ts` both declared `RunRecord`,
`SideSummary`, `EnvDescriptor` and `VerificationReport`, plus all four Zod schemas.
The copies had drifted: `EnvDescriptor.ledger` was `Ledger` in one and `string` in the
other, so a `SignedReport` from one module would not assign to the other.

SPEC.md is inconsistent here. Section 6.5 prints `ledger: string`, while the section
6.11 drift guard requires `Exact<VerificationReport, z.infer<VerificationReportSchema>>`,
which the enum schema can only satisfy with `ledger: Ledger`.

Decision: the narrow types win, because they satisfy the section 6.11 guard, and they
live only in `src/core/schema.ts`, which section 15 makes the owner of every shared
interface and schema. `src/trust/report.ts` imports and re-exports them, so every
existing import path still works.

The four types are TYPE ALIASES, not interfaces. A report is hashed and signed, so it
must satisfy `Canon`, and TypeScript gives an implicit index signature to an object
type alias and not to an interface.

## 4. One canonicaliser per record

There were three copies of the rule that turns a `NodeDetail` into a canonical value:
`detailDigestInput` in `src/core/ids.ts`, `canonicalDetail` in `src/cli/genesis.ts`,
and `detailToCanon` in `src/evolve/run.ts`. The third listed the fields by hand, so a
field added later would have been dropped there and kept elsewhere. Two machines would
then hash one detail to two ids and every signature over that node would fail.

`src/core/ids.ts` now holds the only copy, as `detailToCanon` (node as given) and
`detailDigestInput` (node blanked, per section 6.4). The other two modules import it.
The canonical values are byte-identical to the hand-written one, because every nested
schema is a `strictObject` with exactly the fields it listed.

## 5. `src/evolve/run.ts` no longer builds the digest from the store

`resolveDeps` called `buildDigest(config, store)` with two arguments and a cast to
`PetriStore`. `buildDigest` takes one `DigestInput`, which needs the materialised
nodes, and materialising them needs the consensus log, which only the CLI opens.

Decision: `resolveDeps` falls back to the digest of an EMPTY tree, and every caller
that holds a loaded tree passes `digest` in the overrides. `src/cli/node.ts` (`petri
submit`) now does so, so the guards still see saturated areas and exhausted motifs.
`evolve` layering is preserved: `src/evolve/` never imports `src/cli/`.

## 6. `PetriStore.readHarness` was an invented name

`src/evolve/run.ts` called `store.readHarness(id)`. `PetriStore` reads a harness with
`getHarness`, because it reads the object store rather than a node directory. The call
site was corrected. `PetriStore.init` and `PetriStore.addVerification` already existed
and no caller invents `putVerification`, so nothing was added to the store.

The `StorePort` interface inside `src/evolve/run.ts` keeps the name `readHarness`. It
is that module's own port, not a claim about the store.

## 7. Known duplication that is deliberate and was left alone

`stableOrder` is written twice, in `src/config.ts` and in `src/store/json.ts`. It is
the pretty writer of section 2.3. Those bytes are NEVER hashed, and `src/config.ts`
sits below `src/store/` in the import graph, so it may not import the other copy. The
file comment in `src/config.ts` already says so.

`bench/src/schema.ts` restates `EnvDescriptor` with `ledger: string` and
`mode: string`. `bench` sits at layer L3 and may not import `src/trust/`. The narrow
core type assigns to this wider one, so the two never disagree in the direction that
matters. Left as documented.

## 8. What the follow-up checks found

- One `sha256` helper, in `src/core/canonical.ts`. One `createHash` call in the repo.
- One canonical JSON encoder, in `src/core/canonical.ts`. The framing serialiser of
  section 3.4 is the documented second one, for file trees only, domain separated by
  its first line.
- No path in `harness/` reads the filesystem at all. `bench/src/taskLoader.ts` keeps
  `test.mjs` in `LoadedTask.specSource` and out of `LoadedTask.view`, which is the only
  thing `solve` receives. The replay model client reads `task.json` and
  `answers/<grade>.mjs`, never `test.mjs`.
- All 20 task directories hold `task.json`, `PROMPT.md` and `test.mjs`. Each also has
  an `answers/` directory, which section 10.2 declares. Every one of them is EMPTY, so
  no reference solution was left behind. `--allow-graded` has nothing to draw on until
  those answers are written.
