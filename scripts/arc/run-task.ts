// scripts/arc/run-task.ts — the command-line entrypoint to the ethonlineArc task flow.
//
// It is a THIN wrapper: it loads .env, works out which account is the requester, and
// hands off to runTaskFlow() in lib/arc/task-flow.ts (the SAME code the curl endpoint
// pages/api/arc/run-task.ts runs — one source of truth, so CLI and API behave identically).
//
// The full lifecycle runTaskFlow performs:
//   negotiate + create task → real OpenAI audit (+ TEE attestation) → add to db + /skills +
//   whitelist the agent → requester approval mints a VERIFIED NFT → rate + comment the auditor.
//
//   npx tsx scripts/arc/run-task.ts price-checker.js                    # local demo → SAFE
//   npx tsx scripts/arc/run-task.ts safe-weather-skill 0.0.9227937    # demo → SAFE, licensed to that account
//   npx tsx scripts/arc/run-task.ts left-pad 0.0.9227937              # an npm package
//   npx tsx scripts/arc/run-task.ts https://unpkg.com/is-odd/index.js 0.0.9228428   # a url
//
// Args:  <skill>             — local path | demo name | npm package | url (required)
//        [requester-account] — the Hedera account to license (optional; see resolution below)

// Load env first so OPENAI_API_KEY / HEDERA_* are available before the flow runs.
import { config } from "dotenv";
config({ path: ".env.local" }); // .env.local wins
config();                       // then plain .env

import { runTaskFlow } from "../../lib/arc/task-flow";
import { REQUESTER } from "../../lib/hederaone/demo-skills";

async function main() {
  const ref = process.argv[2]; // arg 1: the skill/package to audit
  if (!ref) {
    console.log(`\nUsage: npx tsx scripts/arc/run-task.ts <skill> [requester-account]\n  <skill> = local path | demo name | npm package | url`);
    return;
  }

  // The requester = the agent that wants the skill and gets licensed on a SAFE verdict.
  // Resolution order: explicit CLI arg → the agent's own account from env (the Hermes agent
  // exports ARC_AGENT_ID after registering) → the demo REQUESTER (so the demo never breaks).
  const envAgent = process.env.ARC_AGENT_ID || process.env.AGENT_ID || process.env.AGENTS_ID || process.env.HERMES_AGENT_ID;
  const agentId = process.argv[3] || envAgent || REQUESTER;
  const source = process.argv[3] ? "cli arg" : envAgent ? "env (ARC_AGENT_ID)" : "fallback (demo REQUESTER)";
  console.log(`\x1b[2magent ${agentId} (${source})\x1b[0m`);

  // color:true → ANSI-coloured output; write → print each streamed line to the terminal.
  await runTaskFlow({ agentId, skillRef: ref, color: true, write: (l) => console.log(l) });
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
