import { claimBp, isBlocked, isRoot, objectiveOf, rootRerunBp } from "./format";
import type { ExportNode } from "./types";

/** The quantity a direction is judged on. */
export type Metric = "score" | "tokens" | "time";

export function metricOf(objective: string): Metric {
  if (objective === "token savings") return "tokens";
  if (objective === "speed") return "time";
  return "score";
}

/** The measured value of one metric for one version. A blocked version has none. */
export function valueOf(n: ExportNode, metric: Metric, nodes: ExportNode[], ids: Set<string>): number | null {
  if (isBlocked(n)) return metric === "score" ? claimBp(n, nodes) : null;
  if (metric === "tokens") return n.costs.tokensPerTask > 0 ? n.costs.tokensPerTask : null;
  if (metric === "time") return n.costs.medianWallMs > 0 ? n.costs.medianWallMs : null;
  if (isRoot(n, ids)) return rootRerunBp(n, nodes) ?? (n.detail.claimedMedianBp > 0 ? n.detail.claimedMedianBp : null);
  return n.verifications.find((v) => v.counted)?.candidate.medianBp ?? n.detail.claimedMedianBp;
}

/**
 * The gain from one value to another, positive when it got better.
 * Score going up is a gain. Tokens or time going DOWN is a gain (a saving, a speed-up).
 */
export function gain(from: number | null, to: number | null, metric: Metric): number | null {
  if (from === null || to === null || from === 0) return null;
  const change = ((to - from) / from) * 100;
  return metric === "score" ? change : -change;
}

export function fmtPct(p: number | null): string {
  if (p === null) return "—";
  const r = Math.round(p);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

export interface Changes {
  /** Gain on this version's own direction, against its parent. */
  local: number | null;
  /** Gains against the start of the tree: one shared scale for the whole graph. */
  accuracy: number | null;
  tokenSavings: number | null;
  isStart: boolean;
}

export function changesOf(n: ExportNode, nodes: ExportNode[]): Changes {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const ids = new Set(byId.keys());
  const metric = metricOf(objectiveOf(n));
  const parent = byId.get(n.parent);
  let root: ExportNode = n;
  const seen = new Set<string>();
  while (!isRoot(root, ids) && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.parent)!; }
  const v = (x: ExportNode, m: Metric) => valueOf(x, m, nodes, ids);
  return {
    local: parent ? gain(v(parent, metric), v(n, metric), metric) : null,
    accuracy: gain(v(root, "score"), v(n, "score"), "score"),
    tokenSavings: gain(v(root, "tokens"), v(n, "tokens"), "tokens"),
    isStart: root.id === n.id,
  };
}
