// lib/state.ts — persist the seeded MARS infra (main registry + voting + review topics) to disk,
// so the demo and the /register-agent skill always reuse the SAME main HCS registry. Server-side only.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const FILE = join(process.cwd(), "mars-state.json");

export interface MarsState {
  registryTopicId?: string;
  votingTopicId?: string;
  reviewTopicId?: string;
  chatRoomTopicId?: string; // the one global HCS-16 negotiation room (communication topic)
  chatFloraId?: string; // label used in HCS-16 operator_id (`sender@<floraId>`)
  verifiedTokenId?: string; // the HTS VERIFIED NFT collection (minted to a skill that passes + is approved)
  lastRunKickoff?: number; // epoch ms of the last async /api/run-task kickoff (so /api/run-status finds that run)
}

export function loadState(): MarsState {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf-8")) as MarsState) : {};
  } catch {
    return {};
  }
}

export function saveState(patch: MarsState): MarsState {
  const next = { ...loadState(), ...patch };
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}
