// lib/arc/escrow-server.ts — SERVER-ONLY. Drives the ethonlineArc contract on Arc testnet from the
// task flow (lib/arc/task-flow.ts). Three hooks, each mirrored onto the Hedera task topic:
//   • PART 1   openAndFundEscrow()  — on agreement, lock BOTH sides (0.1 / 0.1 demo):
//                                     createJob → developer.fundFee + auditor.postBond → Funded
//   • PART 2a  resolveEscrow()      — SETTLE (audit approved): release fee + bond → auditor → Settled
//   • PART 2b  slashEscrow()        — SLASH (audit rejected): bond → reporter (the auditor that
//                                     caught it), fee refunded → developer → Slashed
//
// TWO ARC EOAs play the two sides (Circle USDC, 6 decimals). Each side resolves from env, with a
// single-key fallback so the demo still runs with only one key configured:
//   • DEVELOPER (funds the FEE)            = ARC_DEVELOPER_KEY → else ARC_PRIVATE_KEY
//   • AUDITOR / seller (posts the BOND,    = SELLER_PRIVATE_KEY → else ARC_PRIVATE_KEY
//     receives the settle payout)
//   → set SELLER_PRIVATE_KEY (distinct from ARC_PRIVATE_KEY) for a genuine TWO-PARTY flow where the
//     money moves between two addresses; leave it unset for SINGLE-KEY (one account, both roles).
// Both addresses must hold a little testnet USDC (faucet.circle.com — it's also the Arc gas token);
// the contract pulls via approve()+transferFrom, so each approves the escrow once.
//
// NEVER import this from a client component — it reads private keys. Everything here is fail-soft at
// the CALLER: if the keys/funds aren't there the flow logs and continues (the audit + Hedera + NFT
// never depend on the Arc leg). Verified live end-to-end: SAFE → settle, DANGEROUS → slash.
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAgentKey } from "./x402";
import {
  ESCROW_ABI, ESCROW_ADDRESS, USDC_ABI, USDC_ADDRESS, USDC_DECIMALS,
  STATUS_LABELS, arcTestnet, explorerTx,
} from "./escrow";

// Demo escrow amounts (USDC base units, 6 decimals). Both sides put 0.1 USDC. Small on purpose
// so the FULL lifecycle runs live on a faucet balance. The negotiation still QUOTES 1 USDC /
// 2,500 USDC — these are what actually move on-chain. Override with ESCROW_FEE_USDC / ESCROW_BOND_USDC.
const FEE_BASE = process.env.ESCROW_FEE_USDC ?? "100000";   // 0.1 USDC (demo)
const BOND_BASE = process.env.ESCROW_BOND_USDC ?? "100000"; // 0.1 USDC (demo)

export interface EscrowFundResult {
  jobId: number;
  developer: string; auditor: string;
  fee: string; bond: string;          // human USDC
  feeBase: string; bondBase: string;  // base units
  status: string;                     // STATUS_LABELS[...]
  createTx: string; fundFeeTx: string; postBondTx: string;
  devApproveTx?: string; audApproveTx?: string;
}
export interface EscrowResolveResult {
  jobId: number;
  outcome: "settled" | "slashed";
  tx: string;
  paidTo: string;        // settle → auditor; slash → reporter
  amount: string;        // human USDC moved to paidTo (settle → fee+bond; slash → bond)
  feeRefunded?: string;  // slash only — fee returned to the developer
  status: string;        // STATUS_LABELS (Settled / Slashed)
}

/**
 * The DEVELOPER (requester) key — the side that funds the fee. Prefers ARC_DEVELOPER_KEY, else
 * falls back to the base agent key (ARC_PRIVATE_KEY).
 */
function getDeveloperKey(): `0x${string}` {
  let pk = process.env.ARC_DEVELOPER_KEY?.trim() || process.env.DEV_ARC_PRIVATE_KEY?.trim();
  if (!pk) return getAgentKey(); // fallback: the base agent key funds the fee
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  return pk as `0x${string}`;
}

/**
 * The AUDITOR (seller) key — the side that posts the bond + receives the payout. Prefers
 * SELLER_PRIVATE_KEY (a DISTINCT seller address → genuine two-party flow), else falls back to the
 * base agent key. So: SELLER_PRIVATE_KEY set → two parties; unset → single-key (one account, both roles).
 */
function getAuditorKey(): `0x${string}` {
  let pk = process.env.SELLER_PRIVATE_KEY?.trim() || process.env.AUDITOR_PRIVATE_KEY?.trim();
  if (!pk) return getAgentKey(); // fallback: the base agent key plays the auditor too
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  return pk as `0x${string}`;
}

/** The two escrow addresses (developer == auditor in single-key mode). */
export function escrowAccounts() {
  return {
    developer: privateKeyToAccount(getDeveloperKey()).address,
    auditor: privateKeyToAccount(getAuditorKey()).address,
  };
}

/** True when the keys resolve — the escrow can always run (single-key if no distinct dev/seller key). */
export function escrowConfigured(): boolean {
  try { getDeveloperKey(); getAuditorKey(); return true; } catch { return false; }
}

/** The configured demo amounts (base units + human USDC). */
export function escrowAmounts() {
  return {
    feeBase: FEE_BASE, bondBase: BOND_BASE,
    fee: formatUnits(BigInt(FEE_BASE), USDC_DECIMALS),
    bond: formatUnits(BigInt(BOND_BASE), USDC_DECIMALS),
  };
}

/** viem clients: a shared read client + a wallet client bound to each side's key. */
function clients() {
  const developer = privateKeyToAccount(getDeveloperKey());
  const auditor = privateKeyToAccount(getAuditorKey());
  const pub = createPublicClient({ chain: arcTestnet, transport: http() });
  const devWallet = createWalletClient({ account: developer, chain: arcTestnet, transport: http() });
  const audWallet = createWalletClient({ account: auditor, chain: arcTestnet, transport: http() });
  return { developer, auditor, pub, devWallet, audWallet };
}

/**
 * PART 1 — agreement → lock both sides into the escrow.
 *   createJob(developer, auditor, fee, bond) → developer.fundFee + auditor.postBond → Funded.
 * Each side approve()s the escrow once (1000 USDC allowance) before its transfer is pulled.
 * Throws (clear message) on a missing key / low balance — the caller catches and continues.
 */
export async function openAndFundEscrow(opts?: { feeBase?: string; bondBase?: string }): Promise<EscrowFundResult> {
  const feeBase = BigInt(opts?.feeBase ?? FEE_BASE);
  const bondBase = BigInt(opts?.bondBase ?? BOND_BASE);
  const { developer, auditor, pub, devWallet, audWallet } = clients();

  // Balance guards → readable errors instead of an opaque revert.
  const sameAccount = developer.address.toLowerCase() === auditor.address.toLowerCase();
  const devBal = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [developer.address] }) as bigint;
  const audBal = sameAccount ? devBal : await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [auditor.address] }) as bigint;
  if (sameAccount) {
    // single-key mode: one wallet must cover BOTH the fee and the bond
    if (devBal < feeBase + bondBase) throw new Error(`account ${developer.address} USDC ${formatUnits(devBal, 6)} < fee+bond ${formatUnits(feeBase + bondBase, 6)} (fund it at faucet.circle.com)`);
  } else {
    if (devBal < feeBase) throw new Error(`developer ${developer.address} USDC ${formatUnits(devBal, 6)} < fee ${formatUnits(feeBase, 6)} (fund it at faucet.circle.com)`);
    if (audBal < bondBase) throw new Error(`auditor ${auditor.address} USDC ${formatUnits(audBal, 6)} < bond ${formatUnits(bondBase, 6)} (fund it at faucet.circle.com)`);
  }

  // jobId is assigned as the current nextJobId (the contract does `jobId = nextJobId++`).
  const jobId = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "nextJobId", args: [] }) as bigint;

  // createJob — sent by the auditor wallet acting as the marketplace operator.
  const createTx = await audWallet.writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "createJob", args: [developer.address, auditor.address, feeBase, bondBase] });
  await pub.waitForTransactionReceipt({ hash: createTx });

  // Developer locks the FEE (approve once, then fundFee).
  let devApproveTx: `0x${string}` | undefined;
  const devAllow = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "allowance", args: [developer.address, ESCROW_ADDRESS] }) as bigint;
  if (devAllow < feeBase) {
    devApproveTx = await devWallet.writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [ESCROW_ADDRESS, parseUnits("1000", USDC_DECIMALS)] });
    await pub.waitForTransactionReceipt({ hash: devApproveTx });
  }
  const fundFeeTx = await devWallet.writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "fundFee", args: [jobId, feeBase] });
  await pub.waitForTransactionReceipt({ hash: fundFeeTx });

  // Auditor locks the BOND (approve once, then postBond).
  let audApproveTx: `0x${string}` | undefined;
  const audAllow = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "allowance", args: [auditor.address, ESCROW_ADDRESS] }) as bigint;
  if (audAllow < bondBase) {
    audApproveTx = await audWallet.writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [ESCROW_ADDRESS, parseUnits("1000", USDC_DECIMALS)] });
    await pub.waitForTransactionReceipt({ hash: audApproveTx });
  }
  const postBondTx = await audWallet.writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "postBond", args: [jobId, bondBase] });
  await pub.waitForTransactionReceipt({ hash: postBondTx });

  // Confirm the on-chain state is Funded (both legs locked).
  const job = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [jobId] }) as { status: number };
  return {
    jobId: Number(jobId), developer: developer.address, auditor: auditor.address,
    fee: formatUnits(feeBase, 6), bond: formatUnits(bondBase, 6),
    feeBase: feeBase.toString(), bondBase: bondBase.toString(),
    status: STATUS_LABELS[Number(job.status)] ?? String(job.status),
    createTx, fundFeeTx, postBondTx, devApproveTx, audApproveTx,
  };
}

/**
 * PART 2a — SETTLE (clean audit / approved): release(jobId) pays fee + bond to the auditor → Settled.
 */
export async function resolveEscrow(jobId: number): Promise<EscrowResolveResult> {
  const { auditor, pub, audWallet } = clients();
  const tx = await audWallet.writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "release", args: [BigInt(jobId)] });
  await pub.waitForTransactionReceipt({ hash: tx });
  const job = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(jobId)] }) as { status: number; fee: bigint; bond: bigint };
  return {
    jobId, outcome: "settled", tx, paidTo: auditor.address,
    amount: formatUnits(BigInt(job.fee) + BigInt(job.bond), 6),
    status: STATUS_LABELS[Number(job.status)] ?? String(job.status),
  };
}

/**
 * PART 2b — SLASH (rejected/dangerous): slash(jobId, reporter) sends the bond to `reporter` and
 * refunds the fee to the developer → Slashed. Default reporter = the auditor that caught it.
 */
export async function slashEscrow(jobId: number, reporter?: string): Promise<EscrowResolveResult> {
  const { auditor, pub, audWallet } = clients();
  const to = (reporter ?? auditor.address) as `0x${string}`;
  const tx = await audWallet.writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "slash", args: [BigInt(jobId), to] });
  await pub.waitForTransactionReceipt({ hash: tx });
  const job = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(jobId)] }) as { status: number; fee: bigint; bond: bigint };
  return {
    jobId, outcome: "slashed", tx, paidTo: to,
    amount: formatUnits(BigInt(job.bond), 6),
    feeRefunded: formatUnits(BigInt(job.fee), 6),
    status: STATUS_LABELS[Number(job.status)] ?? String(job.status),
  };
}

export { ESCROW_ADDRESS, explorerTx };
