import type { ExportNode, NodeStatus } from "./types";

/** One task is 500bp on a 20-task bench. 100bp is one percentage point. */
export const tasksOf = (bp: number, total: number): number => Math.round((bp / 10000) * total);
export const tasks = (bp: number, total: number): string => `${tasksOf(bp, total)} of ${total} tasks`;
export const shortTasks = (bp: number, total: number): string => `${tasksOf(bp, total)}/${total} tasks`;

export function signedBp(bp: number | null): string {
  if (bp === null) return "not checked yet";
  if (bp === 0) return "0bp";
  return `${bp > 0 ? "+" : "−"}${Math.abs(bp)}bp`;
}

/** The CLI's own words, so the page and the terminal never disagree. */
export const STATUS_WORD: Record<NodeStatus, string> = {
  accepted: "ACCEPTED",
  rejected: "REJECTED",
  pending: "PENDING",
  contested: "CONTESTED",
  withdrawn: "WITHDRAWN",
  superseded: "SUPERSEDED",
};

export const counted = (n: ExportNode): number => n.verifications.filter((v) => v.counted).length;
export const ignored = (n: ExportNode): number => n.verifications.filter((v) => !v.counted).length;

export const isRoot = (n: ExportNode, ids: Set<string>): boolean =>
  n.parent === "root" || !ids.has(n.parent);

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A root has no parent, so nobody verifies it directly.
 * The keys that checked its children re-ran it as their "parent" side. Show that number.
 */
export function rootRerunBp(root: ExportNode, nodes: ExportNode[]): number | null {
  for (const n of nodes) {
    if (n.parent !== root.id) continue;
    const v = n.verifications.find((x) => x.counted);
    if (v) return v.parent.medianBp;
  }
  return null;
}

export function nodeNumbers(n: ExportNode, nodes: ExportNode[], total: number, minVer: number): string {
  const ids = new Set(nodes.map((x) => x.id));
  const c = counted(n);
  if (isRoot(n, ids)) {
    const rerun = rootRerunBp(n, nodes);
    return rerun === null
      ? `baseline · claims ${shortTasks(n.detail.claimedMedianBp, total)}`
      : `baseline · ${shortTasks(rerun, total)} when re-run`;
  }
  if (isBlocked(n)) return `claims ${shortTasks(claimBp(n, nodes), total)} · 0 of ${minVer} keys`;
  if (n.status === "pending") {
    // One key has measured it: show that measurement, not the author claim.
    const v = n.verifications.find((x) => x.counted);
    return v
      ? `${shortTasks(v.candidate.medianBp, total)} · ${signedBp(v.deltaMedianBp)} · ${c} of ${minVer} keys`
      : `claims ${shortTasks(n.detail.claimedMedianBp, total)} · ${c} of ${minVer} keys`;
  }
  return `${shortTasks(n.detail.claimedMedianBp, total)} · ${signedBp(n.verifiedDeltaBp)} · ${c} ${c === 1 ? "key" : "keys"} agree`;
}

/** A guard or the typecheck stopped this change, so the benchmark never ran. */
export const isBlocked = (n: ExportNode): boolean =>
  n.detail.mechanical !== undefined && n.detail.mechanical.cls !== "ok";

/** The direction a change aims for. A real proposal states its metric: score or tokens. */
export function objectiveOf(n: ExportNode): string {
  if (n.objective) return n.objective;
  return n.detail.proposal.metric === "tokens" ? "token savings" : "accuracy";
}

/** Plain words for why a change never ran. The exact code stays in the detail panel. */
export function blockedText(cls: string): string {
  if (cls.startsWith("typecheck")) return "did not compile";
  if (cls === "sandbox-violation") return "stopped by a safety check";
  if (cls === "patch-out-of-bounds") return "changed a frozen file";
  if (cls === "not-scored") return "not scored yet";
  if (cls === "malformed-proposal") return "the proposal was malformed";
  return "stopped before scoring";
}

/** The word shown for a version. A blocked change reads BLOCKED, not PENDING: it will never be scored. */
export const wordOf = (n: ExportNode): string => STATUS_WORD[n.status];

/**
 * The author's claim for a change that was never scored: its parent's score plus the
 * delta the proposal predicted. It is a claim, never a measurement, and reads as one.
 */
export function claimBp(n: ExportNode, nodes: ExportNode[]): number {
  const ids = new Set(nodes.map((x) => x.id));
  const parent = nodes.find((x) => x.id === n.parent);
  const base = parent === undefined
    ? 0
    : isRoot(parent, ids)
      ? rootRerunBp(parent, nodes) ?? parent.detail.claimedMedianBp
      : parent.verifications.find((v) => v.counted)?.candidate.medianBp ?? parent.detail.claimedMedianBp;
  return Math.max(0, Math.min(10000, base + (n.detail.proposal.predictedDelta || 0)));
}
