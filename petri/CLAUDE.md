# Petri — working notes for Claude

Read `SPEC.md` before you change anything. It is a binding contract, not
documentation. It fixes the bytes that get hashed, the bytes that get signed,
the acceptance rule, and the CLI surface. Ten modules are written against it.

## What Petri is

A git for AI agent harness evolution. Each node holds a hypothesis in plain
English, a diff, a measured benchmark result, and signatures from machines that
re-ran it. Rejected nodes are kept forever, because a recorded dead end stops
the next person repeating it.

## Six rules that must survive every change

1. An author can never verify their own node. Two reports from one key count as one.
2. Every candidate runs 5 times. The median decides. An even count is refused.
3. Rejected nodes are never deleted.
4. Exactly one canonical JSON encoder and one sha256 helper exist. Never add a second.
5. The harness must never read the benchmark tests.
6. It must run with no API key and no Hedera account.

## How to run it

```bash
pnpm install
pnpm typecheck        # must be silent
pnpm test             # 84 tests
pnpm petri status     # identity, policy, mode, ledger
pnpm petri tree       # the whole tree, rejected branches included
pnpm petri digest     # what an agent reads before proposing
pnpm petri dead-ends  # every failure with its reason
```

Open `web/index.html` for the tree view.

## State as of this handoff

Working: typecheck clean, 84 tests pass, the tree loads. It ships one accepted
node at +7000bp, one rejected node at -7000bp, and one pending root. Replay mode
needs no API key.

A hostile audit found five defects and all five are fixed:

| Defect | Fix |
|---|---|
| Node id held wall time, absolute paths and a random UUID | Identity and observation fields are now separate. Only identity is hashed. |
| The harness could read the test files | It runs in a child process that cannot reach them. A type signature is not a boundary. |
| The log path was hardcoded to one machine | It derives from the tree root. |
| Printed verifier counts did not match the counted set | Output now says `2 counted, 1 ignored (duplicate key)`. |
| The web page showed invented data as if real | A banner states it is example data. |

## Language that must stay accurate

Say **two distinct signing keys**, never *two strangers*. One person can hold
every key on a local ledger. The CLI says this on every command. Do not remove
that qualifier.

A Hedera topic gives shared order and a timestamp. It does **not** prove a
verifier actually ran the benchmark. Nothing here does yet.

## Next

1. `petri evolve` does not exist, though the CLI text mentions it. It is the
   demo's third scene: an agent reads a failure, then makes a better attempt.
2. World ID Selfie Check, to make each verifier a distinct live human.
3. x402 pay per verification run, which also limits spam submissions.

This repo's root already holds working Hedera HCS and World AgentKit code.
Call it rather than writing it again.
