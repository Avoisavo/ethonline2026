// Client-safe contract metadata for the ethonlineArc escrow on Arc testnet.
// No private keys, no node-only imports — safe to import from the browser.
import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

// USDC on Arc — the ERC-20 face of the native USDC the Circle faucet funds. 6 decimals.
export const USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;
// ethonlineArc, deployed via hardhat/arc/ignition/modules/ethonlineArc.ts.
// v3: createJob accepts a 0/0 DRAFT; fundFee(jobId, fee) and postBond(jobId, bond) take the
// amount AT fund time (so each side locks its own amount independently — no ordering trap).
// setTerms() is still available to pre-set the agreed price for display.
export const ESCROW_ADDRESS =
  "0xCf33C5B0EA4CBbB4291aB7265c2725106167dfE2" as const;

export const USDC_DECIMALS = 6;

// Circle Gateway Wallet on Arc (deposit here once to "register" as a Gateway account).
export const GATEWAY_WALLET =
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
export const GATEWAY_DOMAIN = 26; // Arc domain id (for Gateway balance lookups)

// x402 / Gateway batched-payment params (client-safe; used to sign EIP-3009 in-browser).
export const X402_NETWORK = "eip155:5042002";
export const X402_PRICE_BASE_UNITS = "10000"; // 0.01 USDC (6 decimals)
export const X402_MAX_TIMEOUT = 604900; // ~7 days + buffer (Gateway minimum is 7 days)
export const GATEWAY_BATCHED_NAME = "GatewayWalletBatched";
export const GATEWAY_BATCHED_VERSION = "1";

export const GATEWAY_WALLET_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const USDC_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const ESCROW_ABI = [
  {
    type: "function",
    name: "nextJobId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "developer", type: "address" },
      { name: "auditor", type: "address" },
      { name: "fee", type: "uint256" },
      { name: "bond", type: "uint256" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setTerms",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "bond", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundFee",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "postBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "bond", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "slash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reporter", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "developer", type: "address" },
          { name: "auditor", type: "address" },
          { name: "fee", type: "uint256" },
          { name: "bond", type: "uint256" },
          { name: "feeFunded", type: "bool" },
          { name: "bondPosted", type: "bool" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export const STATUS_LABELS = [
  "None",
  "Open",
  "Funded",
  "Settled",
  "Slashed",
] as const;

export const explorerTx = (hash: string) =>
  `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (addr: string) =>
  `${arcTestnet.blockExplorers.default.url}/address/${addr}`;
