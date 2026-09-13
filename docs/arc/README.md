# Arc payments (ethonlineArc)

USDC payments on **Arc testnet** (Circle): an audit **escrow** contract (developer fee + auditor bond,
settle or slash), **x402 nanopayments** through Circle Gateway (gas-free, paid from a Gateway balance),
and **NFT-gated** skill use. Wallet UI uses wagmi + RainbowKit.

Ported from [derek2403/ethnyc](https://github.com/derek2403/ethnyc). Hedera code (HCS topics, HTS NFT,
audit pipeline, state, db) is **not** duplicated here. Arc code imports it from `lib/hederaone/`.

Related docs:
- [`nanopayments.md`](./nanopayments.md): Circle Gateway nanopayments / x402 reference.
- [`world-id-verification.md`](./world-id-verification.md): World ID was **removed** from `/arc/publish`
  (no "verify you're human" step, `author.humanId` is sent as `null`). The upstream component and API
  routes are kept only as reference there.

---

## Payments model

All money is USDC on Arc. There are two payment paths:

| Path | What it pays for | Mechanism | Who pays |
|---|---|---|---|
| **Escrow** | getting a skill audited | `ethonlineArc` contract, on-chain txs (gas in USDC) | developer locks the **fee**, auditor locks the **bond** |
| **Nanopayment** | using a verified skill | x402 + Circle Gateway, off-chain EIP-3009 signature, batched settlement | the buyer's Gateway (`gw`) balance |

The escrow is conditional: the fee is released to the auditor on approval, and the bond is slashed on
rejection. Nanopayments are direct with no escrow. A paid `use-skill` call mints the VERIFIED HTS NFT
(the license) to the buyer on Hedera.

---

## File map

| Path | What |
|---|---|
| `lib/arc/escrow.ts` | Client-safe: `arcTestnet` chain, `USDC_ADDRESS`, `ESCROW_ADDRESS`, `GATEWAY_WALLET`, `GATEWAY_DOMAIN`, x402 signing params, `ESCROW_ABI` / `USDC_ABI` / `GATEWAY_WALLET_ABI`, `STATUS_LABELS`, explorer helpers |
| `lib/arc/escrow-server.ts` | Server-only: `openAndFundEscrow` (createJob, fundFee, postBond, then Funded), `resolveEscrow` (release), `slashEscrow` (slash), `escrowConfigured`, `escrowAmounts`, `escrowAccounts`. Resolves two keys: developer and auditor |
| `lib/arc/x402.ts` | Server-only: `FACILITATOR_URL`, `SKILL_SELLER`, price, `getAgentKey()` (reads `ARC_PRIVATE_KEY`), `skillRequirement(payTo, amount)`. Loads `hardhat/arc/.env` and `.env.local` via dotenv |
| `lib/arc/wagmi.ts` | RainbowKit `getDefaultConfig` (appName `ethonlineArc`, chain `arcTestnet`, `ssr: true`) |
| `lib/arc/task-flow.ts` | `runTaskFlow()`: the shared audit flow used by the CLI and `/api/arc/run-task` (post, negotiate, escrow, audit, decide, settle or slash) |
| `components/arc/ArcProviders.tsx` | `WagmiProvider` + react-query + `RainbowKitProvider` (dark theme). Wraps only the `pages/arc/*` pages |
| `pages/arc/test.tsx` | `/arc/test`: manual escrow + x402 playground |
| `pages/arc/publish.tsx` | `/arc/publish`: author flow that publishes a premium skill through escrow, audit, release, and mint |
| `pages/api/arc/*.ts` | Arc API routes (see [Routes](#routes)) |
| `scripts/arc/{test-escrow,test-x402,test-draft,run-task}.ts` | CLI tests and the task-flow entrypoint |
| `hardhat/arc/contracts/ethonlineArc.sol` | The escrow contract (Solidity 0.8.28) |
| `hardhat/arc/ignition/modules/ethonlineArc.ts` | Ignition module `ethonlineArcModule`: deploys `ethonlineArc(ARC_USDC)` |
| `hardhat/arc/{package.json,hardhat.config.ts,.gitignore}` | Standalone Hardhat 3 sub-project (`arcTestnet` network). Also contains `contracts/Counter.sol` and `ignition/modules/Counter.ts` (sample) |
| `pages/_app.tsx` | Imports `@/app/globals.css` (Tailwind for the pages router) |

**Hedera dependencies (from `lib/hederaone/`, do not edit):**
- `hedera`: client, topics, HCS-16 builders, `buildEscrowFunded` / `buildEscrowResolved`, `mintNft` / `transferNft`, HCS-1 upload.
- `state`: `verifiedTokenId`, `registryTopicId`, `chatFloraId`, `lastRunKickoff`.
- Also: `agents`, `demo-skills`, `auditor`, `skill-source.mjs`, `audit-core.mjs`, `db.mjs`, `audit-task`.
- `/arc/publish` calls `POST /api/hederaone/hedera` actions: registry init, `resolveSkill`, `createTask`, `runAudit`, `publishPremiumSkill` (which records `escrowJobId`).

`hardhat/` is excluded from the root `tsconfig.json`, and Hardhat deps are not installed at the root.
`tsconfig` targets ES2020 (BigInt literals).

---

## On-chain constants

These values are defined in `lib/arc/escrow.ts` and `lib/arc/x402.ts`.

| Constant | Value |
|---|---|
| Chain | Arc Testnet, id `5042002` (x402 network `eip155:5042002`) |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Native currency | USDC (18 decimals, used as gas) |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000` (6 decimals) |
| Escrow (`ESCROW_ADDRESS`) | `0xCf33C5B0EA4CBbB4291aB7265c2725106167dfE2` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` (Gateway domain id `26`) |
| EIP-712 domain | `GatewayWalletBatched`, version `1`, verifyingContract = Gateway Wallet |
| Facilitator | `https://gateway-api-testnet.circle.com` (no API key) |
| x402 price | `10000` base units = `0.01` USDC. `maxTimeoutSeconds` is `604900` |
| Default seller (`SKILL_SELLER`) | `0x8864efd5fA1f434699c12D5afbF16746F95CD965` |

`ESCROW_ADDRESS` is the upstream testnet deployment. Its ABI matches `ethonlineArc.sol`. If you redeploy,
update `ESCROW_ADDRESS` in `lib/arc/escrow.ts`.

---

## Escrow lifecycle (`ethonlineArc.sol`)

Status enum: `None(0)`, `Open(1)`, `Funded(2)`, `Settled(3)`, `Slashed(4)`.

1. **`createJob(developer, auditor, fee, bond)`** creates a job with status `Open`. `fee` and `bond` may be
   `0/0` (a draft).
2. **`setTerms(jobId, fee, bond)`** is optional. It is allowed only while `Open` and before either side funds.
3. **`fundFee(jobId, fee)`**: pulls `fee` from `developer` (requires a USDC `approve` first). `fee` must be > 0.
4. **`postBond(jobId, bond)`**: pulls `bond` from `auditor` (requires `approve`). `bond` must be > 0.
   Once the fee and the bond are both in, the status becomes **`Funded`**.
5. From `Funded`, the job ends one of two ways:
   - **`release(jobId)`** (clean audit): `fee + bond` go to the auditor. Status becomes `Settled`.
   - **`slash(jobId, reporter)`** (rejected): `bond` goes to `reporter`, and `fee` is refunded to the
     developer. Status becomes `Slashed`.

The contract is demo-grade and permissionless: anyone can `createJob`, `release` or `slash`. Amounts are
passed at fund time, so each side locks its own amount independently.

### Who funds what

**Task flow** (`lib/arc/escrow-server.ts`), which uses server keys:

| Role | Key (first set wins) | Does |
|---|---|---|
| Developer | `ARC_DEVELOPER_KEY`, then `DEV_ARC_PRIVATE_KEY`, then `ARC_PRIVATE_KEY` | `approve` + `fundFee` |
| Auditor / seller | `SELLER_PRIVATE_KEY`, then `AUDITOR_PRIVATE_KEY`, then `ARC_PRIVATE_KEY` | sends `createJob`, `approve` + `postBond`, sends `release` / `slash`, receives the payout |

- With only `ARC_PRIVATE_KEY` set, one account plays both roles (single-key mode), so it must hold fee + bond.
- Amounts default to `100000` base units (0.1 USDC) each. Override them with `ESCROW_FEE_USDC` / `ESCROW_BOND_USDC`.
- Each side approves the escrow for 1000 USDC the first time.

**`/arc/publish`:**
- The connected wallet is the developer: it runs `approve`, `createJob` (with the auditor set to the server
  agent from `/api/arc/agent`) and `fundFee`.
- The server agent (`ARC_PRIVATE_KEY`) posts the bond through `/api/arc/agent-post-bond`.
- If the verdict is SAFE, the wallet calls `release`. A non-SAFE verdict stops the run, and the job stays `Funded`.
- Defaults: fee 0.1, bond 0.05, royalty 10%, per-use price 0.01 USDC.

### In the task flow (`runTaskFlow`)

1. Post the task (Hedera task topic, status `posted`).
2. Negotiate (HCS-16 room).
3. **Lock the escrow.** `openAndFundEscrow()` runs. When it succeeds, the flow posts an `escrow_funded` receipt
   to the task topic and a registry `job_updated("funded")`.
4. Audit (4 stages).
5. Save the skill and whitelist the requester.
6. The requester decides; review and mint the NFT.
7. Rate the auditor.
8. **Settle or slash.** Approve calls `resolveEscrow`. Block calls `slashEscrow(jobId, auditor)`. Either way
   the flow posts `escrow_resolved` to the task topic.

The Arc leg is **fail-soft**. If keys are missing or balances are too low, the flow logs the problem and
continues. The audit, Hedera records and NFT do not depend on it.

---

## x402 nanopayment leg (Circle Gateway)

`/api/arc/skill` is the x402-protected resource.

1. A request with no `Payment-Signature` header gets **`402`** plus a `PAYMENT-REQUIRED` header. The header is
   base64 JSON `{ x402Version: 2, resource, accepts: [skillRequirement(payTo, amount)] }`, where:
   - scheme is `exact`, network is `eip155:5042002`, and the asset is USDC;
   - `payTo` comes from `?payTo=` (default `SKILL_SELLER`);
   - `amount` comes from `?amount=` (default `10000`).
2. The buyer signs an EIP-3009 `TransferWithAuthorization` against the `GatewayWalletBatched` domain. This
   happens off-chain and costs no gas. The buyer then retries with the base64 payload in `Payment-Signature`.
3. The route calls `POST {FACILITATOR_URL}/v1/x402/settle`. On success it returns `200` with a
   `PAYMENT-RESPONSE` header, `verifiedLink` and `settlementTx`. `settlementTx` is a Gateway transfer id,
   not an on-chain tx.

Requirements:
- The buyer must have a **Gateway balance**: a one-time `approve` + `deposit` into the Gateway Wallet. Server
  callers (`GatewayClient`) auto-deposit 1 USDC when the available balance is below 0.01.
- `payTo` must be a registered Gateway account (it has deposited once) **and** must differ from the buyer.
  Gateway rejects a self-transfer.
- Look up balances with `POST {FACILITATOR_URL}/v1/balances` (domain `26`).
- Look up a transfer with `GET {FACILITATOR_URL}/v1/x402/transfers/:id`. Its status goes
  received, batched, confirmed, completed (or failed).

---

## NFT-gated use: `/api/arc/use-skill`

The VERIFIED HTS NFT (token `verifiedTokenId` from `lib/hederaone` state) is the license. The route accepts
GET or POST with `?skill=<name>&account=<0.0.x>[&pay=1]`. `name`, `agent_id` and `agentId` are accepted as
aliases.

1. It reads the collection from the Hedera Mirror Node (`/api/v1/tokens/<id>/nfts?limit=200`) and matches the
   NFT metadata `skill` to the request.
2. It answers based on the result:

| Case | Response |
|---|---|
| No serial for this skill | `404` (not verified) |
| `account` holds a serial | `200`, `access: "granted"`, `paid: false` |
| Not held, no `pay` | `402` JSON with the terms (0.01 USDC, `pay_to: SKILL_SELLER`) |
| Not held, `&pay=1` | The server agent (`ARC_PRIVATE_KEY`) pays `/api/arc/skill?payTo=SKILL_SELLER` via `GatewayClient`, then `mintNft` + `transferNft` to `account`. The account must be token-associated; otherwise the NFT stays in the treasury. Response is `200` with `paid: true` |

```bash
curl "http://localhost:3000/api/arc/use-skill?skill=safe-weather-skill&account=0.0.9227937"        # holder: free
curl "http://localhost:3000/api/arc/use-skill?skill=safe-weather-skill&account=0.0.9227928"        # non-holder: 402
curl "http://localhost:3000/api/arc/use-skill?skill=safe-weather-skill&account=0.0.9227928&pay=1"  # pay, mint, granted
```

For the demo, the server's wallet pays. The license lives on Hedera and the payment happens on Arc.

---

## Routes

| Route | Purpose |
|---|---|
| `/arc/test` | Manual playground: register with Gateway (deposit), approve, create job (0/0 draft) and set terms, fund fee, post bond (agent), release or slash, then an in-browser x402 payment split between author and auditor |
| `/arc/publish` | Author flow: provide a skill (upload / paste / URL / demo), then approve, create + fund the escrow, agent bond, audit, release, and mint VERIFIED + list the premium skill |
| `GET /api/arc/agent` | The server agent's address, on-chain USDC and Gateway balance (available / pending) |
| `POST /api/arc/agent-post-bond` | `{ jobId, bond? }`: the agent approves and posts the bond. Requires `job.auditor` to be the agent |
| `GET /api/arc/gateway-balance?address=0x…` | Gateway balance proxy (avoids CORS) |
| `GET /api/arc/skill[?payTo=&amount=]` | The x402-protected resource: `402`, then settle via Gateway, then `200` |
| `POST /api/arc/buy-skill` | `{ jobId, authorPct=80 }`: the agent pays 0.01 USDC via x402, split between the job's developer and auditor (not called by the pages) |
| `GET /api/arc/transfer-status?id=` | x402 transfer settlement status |
| `GET/POST /api/arc/use-skill` | NFT-gated use (see above) |
| `GET/POST /api/arc/run-task?agent_id=&skill=` | Streams the task flow as plain text (use `curl -N`) and ends with a `RESULT {json}` line. `?async=1` returns immediately |
| `GET /api/arc/run-status` | Progress of the latest `?async=1` run (reads `db/audits.json`) |

```bash
curl -N "http://localhost:3000/api/arc/run-task?agent_id=0.0.9227937&skill=safe-weather-skill"
```

---

## Environment

Where env is loaded from:
- **Next.js:** `.env.local`. `lib/arc/x402.ts` also loads `hardhat/arc/.env`.
- **Scripts:** `.env.local`, `hardhat/arc/.env` (not `run-task.ts`), then `.env`.
- **Hardhat:** `hardhat/arc/.env`, then `../../.env.local`.

| Var | Used by | Notes |
|---|---|---|
| `ARC_PRIVATE_KEY` | `lib/arc/x402.ts` (`getAgentKey`), escrow fallback, API routes, scripts, Hardhat deployer | **Required** for any Arc leg. Acts as the x402 buyer / server agent |
| `SELLER_PRIVATE_KEY` (alias `AUDITOR_PRIVATE_KEY`) | `lib/arc/escrow-server.ts`, `test-escrow` | Auditor/seller: posts the bond and receives the payout. Unset means single-key mode |
| `ARC_DEVELOPER_KEY` (alias `DEV_ARC_PRIVATE_KEY`) | `lib/arc/escrow-server.ts`, `test-escrow` | Optional distinct developer key (funds the fee) |
| `ESCROW_FEE_USDC` / `ESCROW_BOND_USDC` | `lib/arc/escrow-server.ts` | Base units. Default `100000` (0.1 USDC) each |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | `lib/arc/wagmi.ts` | Optional. Fallback is `ETHONLINE_ARC_DEMO`, which works for injected wallets |
| `ARC_AGENT_ID` (aliases `AGENT_ID`, `AGENTS_ID`, `HERMES_AGENT_ID`) | `scripts/arc/run-task.ts` | Requester Hedera account when no CLI arg is given. Otherwise the demo requester |
| `X402_URL` | `scripts/arc/test-x402.ts` | Default `http://localhost:3000/api/arc/skill` |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `PHALA_ATTESTOR_URL` | `lib/arc/task-flow.ts` | Audit / quote / attestation. Without them the flow uses fallbacks |
| `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` (+ `AUDIT_MODEL`, `OPENAI_REVIEW_MODEL`, `HEDERA_MIRROR_URL`) | via `lib/hederaone` | Needed by the task flow, `use-skill` and `/arc/publish` |

Fund every Arc account with testnet USDC at **faucet.circle.com**. USDC is also Arc's gas token.
The Arc keys, amounts, WalletConnect id and `ARC_AGENT_ID` are listed in `.env.example`.

---

## How to run

```bash
npm install
npm run dev                                   # /arc/test, /arc/publish, /api/arc/*

npx tsx scripts/arc/test-escrow.ts check      # read-only: chain, escrow, keys, balances
npx tsx scripts/arc/test-escrow.ts            # live: createJob, fundFee, postBond, release (fee + bond)
npx tsx scripts/arc/test-draft.ts             # 0/0 draft, fundFee(0.01), postBond(0.02), release (single key)
npx tsx scripts/arc/test-x402.ts              # needs `npm run dev`; pays /api/arc/skill from the gw balance
npx tsx scripts/arc/run-task.ts <skill> [requester-account]   # full task flow incl. escrow settle/slash
```

- `test-x402` deposits 1 USDC into Gateway if the available balance is below 0.01. It fails if the agent
  address equals `SKILL_SELLER`.
- `run-task` accepts `<skill>` as a local path, a demo name, an npm package or a URL.
- Demo names resolve from `demo/skills/<name>` (`lib/hederaone/skill-source.mjs`). Only the clean samples
  `safe-weather-skill` and `price-checker.js` are included (both audit SAFE). ethnyc's malicious samples
  (`poisoned-pdf-skill`, `evil-mcp.json`, `portfolio-helper.js`) were left out on purpose, so the DANGEROUS/slash
  path needs a skill you supply as a path, package or URL.

**Contract (standalone Hardhat 3 project):**

```bash
cd hardhat/arc
npm install
npm run compile
npm run deploy:escrow   # hardhat ignition deploy ignition/modules/ethonlineArc.ts --network arcTestnet --deployment-id escrow-real
```

- `npm run deploy:arc` deploys the sample `Counter`.
- The deployer is `ARC_PRIVATE_KEY`, read through `configVariable`.
- Ignition journals (`ignition/deployments`), `artifacts`, `cache`, `types` and `.env` are gitignored.
- After a new deploy, set `ESCROW_ADDRESS` in `lib/arc/escrow.ts`.
