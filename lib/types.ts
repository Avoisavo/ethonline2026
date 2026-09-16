// The subset of `petri export` (protocol petri/export/1) this UI reads.
// Full contract: the Export* interfaces in petri/src/cli/log.ts.

export type NodeStatus =
  | "accepted" | "rejected" | "pending" | "contested" | "withdrawn" | "superseded";

export interface RunRecord { passed: number; scoreBp: number; tokens: number; wallMs: number }

export interface Side { node: string; medianBp: number; total: number; runs: RunRecord[] }

/** Where one record sits on the Hedera topic. */
export interface HederaRef {
  seq: number;
  txId: string;
  /** Consensus time from the mirror node. Null until `petri hedera check` reads it. */
  timestamp: string | null;
}

export interface HederaTopic {
  topicId: string;
  network: string;
}

export interface ExportVerification {
  reportId: string;
  hedera?: HederaRef | null;
  runner: string;
  runnerLabel: string;
  counted: boolean;
  ignoredWhy: string;
  mode: "live" | "replay";
  runs: number;
  clean: boolean;
  spreadBp: number;
  deltaMedianBp: number;
  parent: Side;
  candidate: Side;
}

export interface ExportNode {
  /** Set on showcase trees, which are not read from the engine. */
  showcase?: boolean;
  /** The direction this change aims for, e.g. "speed". Showcase trees set it. */
  objective?: string;
  id: string;
  short: string;
  label: string;
  seq: number;
  parent: string;
  author: string;
  /** The hash of this version's harness files. Two versions with the same hash run the same code. */
  harness?: string;
  hypothesis: string;
  status: NodeStatus;
  statusCode: string;
  statusReason: string;
  verifiedDeltaBp: number | null;
  disputed: boolean;
  mode: "live" | "replay";
  trust: "hcs" | "local-unverified";
  detail: {
    proposal: {
      hypothesis: string;
      falsifiedIf: string;
      primaryArea: string;
      motif: string;
      predictedDelta: number;
      reasoning: string;
      metric?: string;
    };
    derivedAreas: string[];
    claimedMedianBp: number;
    claimedRuns: RunRecord[];
    provenance: { source: string; model: string };
    /** Set when a guard or the typecheck stopped the change before any measuring. */
    mechanical?: { cls: string; command: string; exitCode: number; evidence: string };
  };
  diff: string;
  verifications: ExportVerification[];
  costs: { medianTokens: number; medianWallMs: number; tokensPerTask: number };
  /** The NodeSubmitted record on the Hedera topic. */
  hedera?: HederaRef | null;
}

export interface PetriExport {
  /** Set on showcase trees, which are not read from the engine. */
  showcase?: boolean;
  protocol: "petri/export/1";
  generatedAt: number;
  tree: string;
  mode: "live" | "replay";
  trust: "hcs" | "local-unverified";
  ledger: { kind: "hcs" | "local"; lastSeq: number; topicId: string };
  /** The Hedera topic that holds a copy of every record. */
  hedera?: HederaTopic | null;
  bench: { id: string; name: string; total: number };
  policy: {
    minDeltaBp: number;
    minRuns: number;
    minVerifications: number;
    maxRunSpreadBp: number;
    maxRunnerDisagreementBp: number;
  };
  runsPerVerification: number;
  stats: {
    total: number; accepted: number; rejected: number; pending: number; contested: number;
    head: string; tips: string[];
  };
  nodes: ExportNode[];
}
