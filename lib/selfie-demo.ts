import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PETRI_ROOT } from "./tree";

/**
 * The SIMULATED Selfie Check for the stage demo.
 *
 * No World App scan happens. The record says `simulated: true`, and that flag
 * goes to Hedera with it. The real Selfie Check flow is on the `world` branch
 * (IDKit `selfieCheckLegacy()` and the v4 verify endpoint).
 *
 * What is real: the record is appended to petri/.petri/world-checks.jsonl, and
 * `petri anchor push` sends it to the Hedera topic. The transaction id and the
 * running hash come back from Hedera and its mirror node.
 */

const run = promisify(execFile);
const TSX = path.join(PETRI_ROOT, "node_modules", ".bin", "tsx");
const WORLD_CHECKS = path.join(PETRI_ROOT, ".petri", "world-checks.jsonl");
const ANCHOR_CONFIG = path.join(PETRI_ROOT, ".petri", "anchor.json");

export type SelfieRecord = {
  checkedAt: number;
  kind: "petri/selfie-check/1";
  node: string;
  nullifier: string;
  protocolVersion: "3.0";
  report: string;
  result: "verified";
  simulated: true;
  tree: string;
};

export type HederaReceipt = {
  topicId: string;
  network: string;
  hcsSeq: number;
  txId: string;
  runningHash: string | null;
  consensusTimestamp: string | null;
  hashscan: string;
  mirror: string;
  sentWithIt: number;
};

export type SelfieDemoResult =
  | { ok: true; record: SelfieRecord; hedera: HederaReceipt }
  | { ok: false; error: string; record: SelfieRecord | null };

/** petri/.env holds the Hedera account. The web server does not load it by itself. */
function petriEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const file = path.join(PETRI_ROOT, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return env;
}

function treeId(): string {
  try {
    return (JSON.parse(readFileSync(path.join(PETRI_ROOT, ".petri", "config.json"), "utf8")) as { treeId: string }).treeId;
  } catch {
    return "unknown";
  }
}

const mirrorHost = (network: string) => `https://${network}.mirrornode.hedera.com`;

/** The mirror node shows a message a few seconds after consensus. */
async function mirrorMessage(network: string, topicId: string, seq: number) {
  const url = `${mirrorHost(network)}/api/v1/topics/${topicId}/messages/${seq}`;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { running_hash?: string; consensus_timestamp?: string };
        if (j.running_hash) {
          return { runningHash: Buffer.from(j.running_hash, "base64").toString("hex"), consensusTimestamp: j.consensus_timestamp ?? null };
        }
      }
    } catch {
      // Try again. The page still shows the transaction id without it.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { runningHash: null, consensusTimestamp: null };
}

type PushJson = {
  topicId?: string;
  pushed?: { source: string; localSeq: number; hcsSeq: number; txId: string }[];
  error?: string | null;
};

export async function runSimulatedSelfieCheck(node: string, report: string): Promise<SelfieDemoResult> {
  if (!/^[0-9a-f]{8,64}$/.test(node)) return { ok: false, error: "The node id is not hexadecimal.", record: null };
  if (report !== "" && !/^[0-9a-f]{64}$/.test(report)) return { ok: false, error: "The report id is not 64 hex characters.", record: null };

  const checkedAt = Date.now();
  const record: SelfieRecord = {
    checkedAt,
    kind: "petri/selfie-check/1",
    node,
    nullifier: `0x${createHash("sha256").update(`petri/simulated-selfie|${node}|${report}|${checkedAt}`).digest("hex")}`,
    protocolVersion: "3.0",
    report,
    result: "verified",
    simulated: true,
    tree: treeId(),
  };
  appendFileSync(WORLD_CHECKS, `${JSON.stringify(record)}\n`, "utf8");
  const localSeq = readFileSync(WORLD_CHECKS, "utf8").split("\n").filter((l) => l.trim() !== "").length;

  if (!existsSync(ANCHOR_CONFIG)) {
    return { ok: false, record, error: "No Hedera topic yet. In petri/, run: pnpm petri anchor create --network testnet" };
  }
  const { network } = JSON.parse(readFileSync(ANCHOR_CONFIG, "utf8")) as { network: string };

  let stdout = "";
  try {
    ({ stdout } = await run(TSX, ["src/cli/index.ts", "--json", "anchor", "push"], {
      cwd: PETRI_ROOT, env: petriEnv(), timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    stdout = err.stdout ?? "";
    if (!stdout.trim()) {
      // The CLI also prints its trust banner to stderr. Show the petri: lines, which say what failed.
      const lines = (err.stderr?.trim() || err.message).split("\n");
      const reason = lines.filter((l) => l.startsWith("petri:"));
      return { ok: false, record, error: (reason.length > 0 ? reason : lines.slice(-4)).join("\n") };
    }
  }

  let parsed: PushJson;
  try {
    parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))) as PushJson;
  } catch {
    return { ok: false, record, error: `petri anchor push printed no JSON: ${stdout.slice(0, 200)}` };
  }
  const mine = parsed.pushed?.find((r) => r.source === "world" && r.localSeq === localSeq);
  if (!mine || !parsed.topicId) {
    return { ok: false, record, error: parsed.error ?? "The record did not reach the Hedera topic." };
  }

  const found = await mirrorMessage(network, parsed.topicId, mine.hcsSeq);
  return {
    ok: true,
    record,
    hedera: {
      topicId: parsed.topicId,
      network,
      hcsSeq: mine.hcsSeq,
      txId: mine.txId,
      ...found,
      hashscan: `https://hashscan.io/${network}/topic/${parsed.topicId}`,
      mirror: `${mirrorHost(network)}/api/v1/topics/${parsed.topicId}/messages/${mine.hcsSeq}`,
      sentWithIt: (parsed.pushed?.length ?? 1) - 1,
    },
  };
}
