# Petri

Evolve an AI agent's harness. Other keys re-run every score before it counts.
Failed versions are kept, so the next agent does not repeat them.

## Run the web app

```bash
npm install
npm run dev          # http://localhost:3000
```

Pick a domain, a model and a harness, then open its tree. The Petri harness tree is read
from the engine in `petri/` through `petri export` on every request. The other trees in the
gallery are showcase trees for other domains.

## Run the engine

```bash
cd petri
pnpm install
pnpm test            # 93 tests
pnpm petri tree      # the tree, rejected branches included
pnpm petri digest    # what the next agent reads
```

See `petri/README.md` for how a node is decided, the recorded tree, and the limits.

## Add a version

```bash
cd petri
MODE=replay ./demo/positive-prompt.sh
```

In replay mode the change is recorded as not scored yet. Scoring it needs a live run with
`ANTHROPIC_API_KEY`, which has not been run on this tree yet.

## Layout

| Path | What it holds |
|---|---|
| `app/`, `components/`, `lib/*.ts` | The Petri web app (Next.js) |
| `petri/` | The engine: CLI, benchmark, harness, the recorded tree |
| `lib/hedera/`, `lib/hedera2/`, `lib/hederaone/`, `pages/api/cannes2026/`, `docs/` | Hedera and World integration code. It builds, and is not connected to Petri yet |
