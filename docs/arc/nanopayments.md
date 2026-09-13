# Circle Nanopayments — Implementation Reference

> Synthesized from all 19 pages of Circle's Gateway Nanopayments documentation (overview, concepts, quickstarts, how-tos, SDK reference, API reference, agent stack). Self-contained: save to `docs/` and read later with no other context. Where the docs conflict, this notes the conflict.

## 1. What a nanopayment is

A **nanopayment** is a gas-free USDC payment as small as **$0.000001** (one millionth of a dollar; USDC has 6 decimals, so the smallest base unit IS one nanopayment). Settling each such payment individually onchain is uneconomical because gas would exceed the payment (the practical floor for per-payment onchain settlement is ~$0.01+). Circle solves this with **batched settlement**: buyers fund a **Gateway balance** once (onchain), then sign **offchain EIP-3009 authorizations** (zero gas); Circle Gateway aggregates thousands of these and settles the **net** result in a **single onchain transaction**, amortizing gas across all of them.

The HTTP-level negotiation uses the open **x402** protocol (built on HTTP `402 Payment Required`). Circle Nanopayments is "a payment method for x402 that uses Circle Gateway's batched settlement infrastructure." It is **non-custodial** (an AWS Nitro Enclave TEE verifies signatures and signs batches; the Gateway Wallet contract verifies the TEE signature onchain before executing) and **additive** (coexists with standard onchain x402 payments).

**Use cases:** AI-agent payments (compute/data/memory/tools), usage-based billing (per API call / compute-second / dataset), M2M marketplaces, streaming value (pay-per-second, micro-rewards).

## 2. Core concepts

| Concept | Summary |
|---|---|
| x402 | HTTP-native payment **negotiation** standard on status 402. NOT a payment system; agnostic to settlement. |
| 402 Payment Required | Unpaid request -> 402 + `PAYMENT-REQUIRED` header. Paid -> 200 + `PAYMENT-RESPONSE`. |
| EIP-3009 TransferWithAuthorization | Offchain EIP-712 message (from,to,value,validAfter,validBefore,nonce) authorizing USDC movement; zero gas. |
| GatewayWalletBatched domain | EIP-712 domain for nanopayment signing: `name:'GatewayWalletBatched', version:'1', chainId, verifyingContract`. Distinct from `GatewayWallet` (withdrawals/crosschain). |
| exact scheme | The only x402 scheme nanopayments use (`CIRCLE_BATCHING_SCHEME='exact'`). |
| Gateway Wallet / balance | Per-chain non-custodial contract; one-time deposit funds a spendable Gateway balance (states: total/available/withdrawing/withdrawable). |
| Batched settlement | Net balance changes from many authorizations applied in one periodic onchain tx. |
| Facilitator | Verifies+settles for sellers. Circle Gateway API is the hosted facilitator; self-hostable. |
| TEE | AWS Nitro Enclave verifies sigs, computes balances, signs batch with KMS key; Nitro attestations prove the code image. |
| EOA only | Buyer must be an Externally Owned Account; Smart Contract Accounts unsupported (ecrecover, not EIP-1271). |

## 3. End-to-end payment flow

1. **(One-time) Deposit.** Buyer deposits USDC into the Gateway Wallet contract onchain (costs gas + native token). `client.deposit('1')`.
2. **Request.** Buyer requests a paid resource.
3. **402.** Seller returns `402` + `PAYMENT-REQUIRED` (base64 JSON `{ x402Version:2, resource, accepts:[requirements] }`).
4. **Sign.** Buyer signs an EIP-3009 `TransferWithAuthorization` offchain (EIP-712, zero gas) against the `GatewayWalletBatched` domain. `validBefore` must be >= 3 days out; fresh random 32-byte nonce.
5. **Retry.** Buyer resends with the base64 payload in the `PAYMENT-SIGNATURE` / `Payment-Signature` header.
6. **Settle & serve.** Seller (via facilitator / `POST /v1/x402/settle`) verifies, locks buyer funds, credits seller's **pending** balance, returns `200` + `PAYMENT-RESPONSE`. Buyer gets the resource immediately.
7. **Batch.** Gateway periodically aggregates pending authorizations, the TEE signs the batch, and one onchain tx applies net changes (Gateway Wallet verifies the TEE signature). Seller funds move pending -> available.
8. **(Optional) Withdraw.** Seller withdraws to any supported chain (same-chain instant; crosschain near-instant, needs native gas on destination).

```
Alice pays Bob 10 USDC
  Initial:                 Alice available 100, Bob 0
  Authorization submitted: Alice available 90,  Bob 0   (Alice's 10 locked)
  Batch settled:           Alice available 90,  Bob 10
```

## 4. Seller guide

Prereqs: an EVM receiving address; Node v22+ (quickstart) / v18+ (additive how-to).

### 4a. Express middleware (from scratch)
```bash
npm install @circle-fin/x402-batching @x402/core @x402/evm viem express tsx typescript
npm install --save-dev @types/node @types/express
```
```ts
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";

const app = express();
const gateway = createGatewayMiddleware({
  sellerAddress: "0xYOUR_WALLET_ADDRESS",
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  // networks: ["eip155:5042002"], // optional restrict; omit = any Gateway chain
});

app.get("/premium-data", gateway.require("$0.01"), (req, res) => {
  const { payer, amount, network } = req.payment!; // PaymentInfo
  const usdc = formatUnits(BigInt(amount), 6);      // base units -> USDC
  res.json({ secret: "...", paid_by: payer });
});
app.listen(3000);
```

### 4b. Additive to an existing x402 server
```ts
import { x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";

const server = new x402ResourceServer([
  new HTTPFacilitatorClient({ url: "https://facilitator.example.com" }),
  new BatchFacilitatorClient(),
]);
server.register("eip155:*", new GatewayEvmScheme());
await server.initialize();
```
`GatewayEvmScheme` extends `ExactEvmScheme` (onchain still works), preserves `extra.verifyingContract`, sets `maxTimeoutSeconds=604900`. Verify: 402 responses include an option with `extra.name === "GatewayWalletBatched"`.

### 4c. Manual / non-Express (e.g. Next.js API route, dynamic pricing)
```ts
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
const facilitator = new BatchFacilitatorClient({ url: "https://gateway-api-testnet.circle.com" });

const requirements = {
  scheme: "exact",
  network: "eip155:5042002",
  asset: "0x3600000000000000000000000000000000000000", // USDC (arcTestnet)
  amount: "10000",                                     // 0.01 USDC
  maxTimeoutSeconds: 604900,
  payTo: "0xYOUR_ADDRESS",
  extra: { name: "GatewayWalletBatched", version: "1",
           verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
};
// no signature -> 402 with PAYMENT-REQUIRED = base64(JSON.stringify({ x402Version:2, resource, accepts:[requirements] }))
// signature    -> payload = JSON.parse(Buffer.from(sig,"base64").toString("utf8"));
const settlement = await facilitator.settle(payload, requirements); // settlement.success
```
Rules: amounts are base-unit strings; call `settle()` directly in prod; a `200` can carry `success:false` — branch on the boolean; replace placeholder addresses with real `CHAIN_CONFIGS` values.

## 5. Buyer guide

Prereqs: Node v22+, an **EOA** private key, testnet USDC (faucet.circle.com), testnet native gas for the deposit.
```bash
npm install @circle-fin/x402-batching viem tsx typescript && npm i -D @types/node
```
```ts
import { GatewayClient } from "@circle-fin/x402-batching/client";

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: process.env.PRIVATE_KEY as `0x${string}`,
});

const b = await client.getBalances();
if (b.gateway.available < 1_000_000n) await client.deposit("1"); // 1 USDC = 1_000_000 base units, onchain/gas

if ((await client.supports(url)).supported) {
  const { data, status } = await client.pay(url); // handles 402 -> sign -> retry
}

await client.withdraw("5");                          // same-chain instant
await client.withdraw("5", { chain: "baseSepolia" }); // crosschain (gas on destination)
```

### Additive client (auto-fallback to onchain)
```ts
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { CompositeEvmScheme, BatchEvmScheme } from "@circle-fin/x402-batching/client";
const composite = new CompositeEvmScheme(new BatchEvmScheme(signer), new ExactEvmScheme(signer));
client.register("eip155:*", composite); // batch when extra.name==="GatewayWalletBatched", else onchain
```

### Manual EIP-3009 signing (custom/non-JS only)
```ts
const domain = { name: "GatewayWalletBatched", version: "1", chainId: 5042002,
  verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" };
const types = { TransferWithAuthorization: [
  {name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
  {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"} ] };
const message = { from:"0xPAYER", to:"0xSELLER", value:10000n, validAfter:0n,
  validBefore: BigInt(Math.floor(Date.now()/1000)+60*60*24*5), // >=3 days; 5d shown
  nonce: `0x${randomBytes(32).toString("hex")}` };
const signature = await account.signTypedData({ domain, types, primaryType:"TransferWithAuthorization", message });
// payload: { x402Version:2, payload:{ authorization:{...stringified...}, signature }, resource, accepted }
// base64-encode JSON -> Payment-Signature header
```
Gotchas: domain name MUST be exactly `GatewayWalletBatched`; `verifyingContract` is the GatewayWallet contract (not USDC); `chainId` is the standard EVM id; stringify bigint fields in the JSON payload; unique nonce each time; any mismatch -> generic `invalid_signature`.

### Monitoring
`client.getTransferById(id)`; `client.searchTransfers({ status, from, to, network, token, startDate, endDate, pageSize, pageAfter, pageBefore })`. `TransferStatus = received | batched | confirmed | completed | failed`.

## 6. Facilitator (self-host, optional)
```bash
npm install @circle-fin/x402-batching @x402/core viem
```
```ts
import { BatchFacilitatorClient, isBatchPayment } from "@circle-fin/x402-batching/server";
const gatewayClient = new BatchFacilitatorClient();

async function handleSettle(payload, requirements) {
  return isBatchPayment(requirements)
    ? gatewayClient.settle(payload, requirements)
    : existingOnChainHandler.settle(payload, requirements);
}
// merge getSupported(): { kinds:[...e,...g], extensions:[...e,...g], signers:{...e,...g} }
// expose POST /v1/x402/verify and POST /v1/x402/settle reading { paymentPayload, paymentRequirements }
```
Prod: call `settle()` directly (latency-optimized, guarantees settlement). Gas-free-only facilitator: `new x402ResourceServer([new BatchFacilitatorClient()])` + `server.register("eip155:*", new GatewayEvmScheme())`.

## 7. SDK reference (`@circle-fin/x402-batching`)

**Subpaths:** `/client` (buyer), `/server` (seller/facilitator), root (shared).

**Buyer — GatewayClient**(`{ chain, privateKey, rpcUrl? }`):
| Method | Returns |
|---|---|
| `deposit(amount, {approveAmount?})` | `{ approvalTxHash?, depositTxHash, amount, formattedAmount }` (onchain, gas) |
| `pay<T>(url, options?)` | `{ data, amount, formattedAmount, transaction, status }` |
| `withdraw(amount, {chain?, recipient?})` | `{ mintTxHash, amount, formattedAmount, sourceChain, destinationChain, recipient }` |
| `getBalances(address?)` | `{ wallet:{balance,formatted}, gateway:{total,available,withdrawing,withdrawable,formattedTotal,formattedAvailable} }` |
| `supports(url)` | `{ supported, requirements?, error? }` |
| `getTransferById(id)` | `TransferResponse` |
| `searchTransfers(params?)` | `{ transfers, pagination? }` |

Also `/client`: `BatchEvmScheme(signer).createPaymentPayload(2, requirements)`, `CompositeEvmScheme(batch, fallback)`, `registerBatchScheme(client,{signer,fallbackScheme?})`, constants `CHAIN_CONFIGS`, `GATEWAY_DOMAINS`.

**Seller/facilitator — `/server`:** `createGatewayMiddleware({sellerAddress, networks?, facilitatorUrl?, description?}).require(price)`; `BatchFacilitatorClient(config?)` with `verify`/`settle`/`getSupported`; `GatewayEvmScheme()`; `isBatchPayment(requirements)`.

**Shared — root:** `supportsBatching(requirements)`, `getVerifyingContract(requirements)`, `CIRCLE_BATCHING_NAME='GatewayWalletBatched'`, `CIRCLE_BATCHING_VERSION='1'`, `CIRCLE_BATCHING_SCHEME='exact'`.

`req.payment` (PaymentInfo): `{ verified, payer, amount, network, transaction? }`.

**CLI** (agent workflows): `npm i -g @circle-fin/cli` then `circle gateway deposit --amount 5 --address 0x.. --chain BASE --method direct`, `circle services search "weather"`, `circle services inspect <url>`, `circle services pay <url> --address 0x.. --chain BASE --max-amount 0.01`, `circle gateway balance --address 0x.. --chain BASE`.

## 8. Gateway x402 REST API

Base URLs: **testnet** `https://gateway-api-testnet.circle.com`, **production** `https://gateway-api.circle.com`. x402 endpoints declare `security: []` (no auth).

| Method & path | Purpose | Key response |
|---|---|---|
| `POST /v1/x402/settle` | Verify sig+balance+nonce, lock funds, queue batch | `{ success, transaction, network, payer, errorReason? }` |
| `POST /v1/x402/verify` | Read-only validation (no balance/nonce; no settle guarantee) | `{ isValid, invalidReason?, payer }` |
| `GET /v1/x402/supported` | Discovery of kinds/assets/contracts | `{ kinds:[{x402Version,scheme,network,extra:{name,version,verifyingContract,assets:[{address,symbol,decimals}]}}], extensions, signers }` |
| `GET /v1/x402/transfers` | Search transfers (cursor paginated) | `{ transfers:[...], pagination? }` |
| `GET /v1/x402/transfers/{id}` | One transfer by UUID | `X402TransferResponse` (404 if not found) |

settle/verify request body (both): `{ paymentPayload:{ x402Version, resource?, accepted, payload, extensions? }, paymentRequirements:{ scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra? } }`.

`errorReason` / `invalidReason` enum: `unsupported_scheme, unsupported_network, unsupported_asset, invalid_payload, address_mismatch, amount_mismatch, invalid_signature, authorization_not_yet_valid, authorization_expired, authorization_validity_too_short, self_transfer, insufficient_balance, nonce_already_used, unsupported_domain, wallet_not_found` (+ `unexpected_error` on 500). Always check `success`/`isValid` — a `200` can be a failure. OpenAPI spec: `https://developers.circle.com/openapi/gateway.yaml`.

Broader (non-x402) Gateway endpoints exist for unified balance: `POST /v1/balances`, `POST /v1/transfer`, `POST /v1/batch/submit`.

## 9. Networks & USDC

EVM-only; supported where the Gateway "supported blockchains" table marks Nanopayments = Yes. **Solana (domain 5) is the only listed chain WITHOUT nanopayments.**

Mainnet (Domain): Ethereum(0), Avalanche(1), OP(2), Arbitrum(3), Base(6), Polygon PoS(7), Unichain(10), Sonic(13), World Chain(14), Sei(16), HyperEVM(19), Arc(26).

Testnet (Domain, SupportedChainName): sepolia(0), avalancheFuji(1), optimismSepolia(2), arbitrumSepolia(3), baseSepolia(6), polygonAmoy(7), unichainSepolia(10), sonicTestnet(13), worldChainSepolia(14), seiAtlantic(16), hyperEvmTestnet(19), arcTestnet(26).

Three network identifier forms: SDK alias (`arcTestnet`), CAIP-2 (`eip155:5042002`, wildcard `eip155:*`), and (in raw settle/verify examples) plain names (`base-sepolia`/`base`). **USDC = 6 decimals**: 1 USDC = 1,000,000 base units; $0.01 = 10,000; min $0.000001 = 1. Arc Testnet: USDC `0x3600…0000`, GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, domain 26. Other chains: `CHAIN_CONFIGS`/`GATEWAY_DOMAINS` or `/gateway/references/contract-addresses` + `/stablecoins/usdc-contract-addresses`.

Deposit finality: Arc ~0.5s; Avalanche/Polygon/Sonic ~8s; HyperEVM/Sei ~5s; Sepolia L1/L2s ~13–19 min. `@circle-fin/bridge-kit` can bridge USDC to a fast-finality chain before depositing.

## 10. Gotchas
- **EOA only** (no SCAs / EIP-1271).
- **Deposit costs gas**; only payments are gasless. Crosschain withdraw needs gas on the destination chain.
- **Units:** compare balances in bigint base units (`1_000_000n`); pass deposit/withdraw amounts as decimal strings.
- **validBefore >= 3 days** (how-to) / quickstart says 7 days; `maxTimeoutSeconds=604900` (~7d). Use ~7 days; hard floor ~3 days.
- **Fresh nonce** per payment.
- **Pending vs available:** seller serves on a pending credit; funds become available after the batch (interval not documented).
- **`200` can be a failure** — check `success`/`isValid`.
- **Domain name must be exactly `GatewayWalletBatched`** (not `GatewayWallet`).
- Header casing varies (`PAYMENT-SIGNATURE` vs `Payment-Signature`; upstream uses `X-PAYMENT`). Prefer the SDK.

## 11. Glossary
See terms above: nanopayment, x402, 402, EIP-3009, GatewayWalletBatched domain, exact scheme, Gateway Wallet/balance, batched settlement, facilitator, EOA/SCA, TEE/Nitro, CAIP-2, SupportedChainName, Domain ID, base units, maxTimeoutSeconds, nonce, withdraw, BatchFacilitatorClient, GatewayClient, Composite/Batch/Exact/GatewayEvmScheme, isBatchPayment.

## 12. Open questions
- x402Version 1 (API examples) vs 2 (SDK/headers) — prefer SDK (v2).
- Header casing / X-PAYMENT vs PAYMENT-* — let SDK handle.
- Network field format the raw settle/verify API actually requires (CAIP-2 vs `base-sepolia`).
- validBefore floor (3 vs 7 days).
- Auth on transfer-query endpoints (security:[] vs Bearer convention).
- Batch interval / availability SLA.
- Per-nanopayment fee model.
- Max payment size / rate limits.
- First-class Next.js (non-Express) integration.
- Node floor (v18 vs v22) — use v22+.

## 13. Sources (developers.circle.com)
- Overview: `/gateway/nanopayments`
- Supported networks: `/gateway/nanopayments/supported-networks`, `/gateway/references/supported-blockchains`
- Concepts: `/gateway/nanopayments/concepts/x402`, `/gateway/nanopayments/concepts/batched-settlement`
- Quickstarts: `/gateway/nanopayments/quickstarts/buyer`, `/gateway/nanopayments/quickstarts/seller`
- How-tos: `/gateway/nanopayments/howtos/x402-buyer`, `/x402-seller`, `/x402-integration`, `/eip-3009-signing`, `/facilitator-integration`
- SDK: `/gateway/nanopayments/references/sdk`
- API: `/api-reference/gateway` and `/api-reference/gateway/all/{settle,verify}-x402payment`, `search-x402transfers`, `get-x402transfer-by-id`, `get-supported-x402payment-kinds`
- Agent Stack: `/agent-stack/agent-nanopayments` (+ `/quickstart`)
- Contract/USDC addresses: `/gateway/references/contract-addresses`, `/stablecoins/usdc-contract-addresses`
- OpenAPI: `https://developers.circle.com/openapi/gateway.yaml`; docs index: `https://developers.circle.com/llms.txt`
- Sample app: `github.com/circlefin/arc-nanopayments`; service discovery: `https://agents.circle.com/services`