import type { ExportNode, NodeStatus } from "./types";

/** Parent to children, as node ids. The tree view walks it top to bottom. */
export interface Forest { roots: string[]; children: Record<string, string[]> }

// Passed branches first, so the line of improvement reads down the left edge.
const RANK: Record<NodeStatus, number> = {
  accepted: 0, pending: 1, contested: 2, rejected: 3, withdrawn: 4, superseded: 5,
};

export function buildForest(nodes: ExportNode[]): Forest {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string, ExportNode[]>();
  const roots: ExportNode[] = [];
  for (const n of nodes) {
    if (n.parent === "root" || !ids.has(n.parent)) { roots.push(n); continue; }
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  const order = (a: ExportNode, b: ExportNode) => RANK[a.status] - RANK[b.status] || a.seq - b.seq;
  const children: Record<string, string[]> = {};
  for (const [parent, list] of kids) children[parent] = list.sort(order).map((n) => n.id);
  return { roots: roots.sort((a, b) => a.seq - b.seq).map((n) => n.id), children };
}

export interface Slot { depth: number; row: number }

/**
 * A tidy tree, like the one-pager's Figure 1. A leaf takes one row, a parent sits
 * centred on its children, and accepted children run through the middle so the
 * line of improvement stays level while failures branch above and below it.
 */
export function tidySlots(
  forest: Forest,
  statusOf: (id: string) => NodeStatus | undefined,
): { slots: Record<string, Slot>; rows: number; maxDepth: number } {
  const slots: Record<string, Slot> = {};
  let leaf = 0;
  let maxDepth = 0;
  const visit = (id: string, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = forest.children[id] ?? [];
    if (kids.length === 0) { slots[id] = { depth, row: leaf++ }; return; }
    const passed = kids.filter((k) => statusOf(k) === "accepted");
    const rest = kids.filter((k) => statusOf(k) !== "accepted");
    const half = Math.ceil(rest.length / 2);
    for (const k of [...rest.slice(0, half), ...passed, ...rest.slice(half)]) visit(k, depth + 1);
    const rs = kids.map((k) => slots[k]!.row);
    slots[id] = { depth, row: (Math.min(...rs) + Math.max(...rs)) / 2 };
  };
  for (const r of forest.roots) visit(r, 0);
  return { slots, rows: Math.max(leaf, 1), maxDepth };
}
