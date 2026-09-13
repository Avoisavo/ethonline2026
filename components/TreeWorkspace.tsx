"use client";

import { useState, type ReactNode } from "react";
import { STATUS_WORD, clip, isBlocked, nodeNumbers, wordOf } from "@/lib/format";
import type { Forest } from "@/lib/layout";
import type { ExportNode } from "@/lib/types";
import { Glyph } from "./Glyph";
import { LineageHero } from "./LineageHero";
import { NodePanel } from "./NodePanel";
import { TreeView } from "./TreeView";

interface Props {
  nodes: ExportNode[];
  forest: Forest;
  initial: string;
  minVerifications: number;
  benchTotal: number;
  /** Rendered beside the full record. */
  info: ReactNode;
  /** The Stats view. */
  stats: ReactNode;
  /** Which view opens first. `?view=stats` sets it. */
  initialView?: View;
}

type View = "tree" | "stats";

export function TreeWorkspace({ nodes, forest, initial, minVerifications, benchTotal, info, stats, initialView = "tree" }: Props) {
  const [selected, setSelected] = useState(initial);
  const [view, setView] = useState<View>(initialView);
  const node = nodes.find((n) => n.id === selected) ?? nodes[0]!;
  const parent = nodes.find((n) => n.id === node.parent) ?? null;
  const shared = { forest, nodes, selected: node.id, onSelect: setSelected, benchTotal, minVerifications };

  return (
    <>
      <div className="view-bar">
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "tree"} onClick={() => setView("tree")}>Tree</button>
          <button type="button" aria-pressed={view === "stats"} onClick={() => setView("stats")}>Stats</button>
        </div>
      </div>

      {view === "tree" ? (
        <figure className="stage">
          <div className="plate tree-plate">
            <div className="legend legend-overlay" aria-label="Legend">
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="accepted" cx={7} cy={7} r={5} /></svg>Accepted — two other keys re-ran it and agreed</span>
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="rejected" cx={7} cy={7} r={5} /></svg>Rejected — kept, with the reason</span>
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="pending" cx={7} cy={7} r={5} /></svg>Pending — waiting for keys</span>
            </div>
            <LineageHero {...shared} />
            <TreeView {...shared} />
          </div>

          <div className={`selected-strip s-${node.status}`} aria-live="polite">
            <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} /></svg>
            <span className="sel-word">{wordOf(node)} · {node.short}</span>
            <span className="sel-hyp">{clip(node.hypothesis, 96)}</span>
            <span className="sel-num">{nodeNumbers(node, nodes, benchTotal, minVerifications)}</span>
            <a href="#record">Full record ↓</a>
          </div>
        </figure>
      ) : (
        stats
      )}

      <section id="record" className="record">
        <NodePanel node={node} parent={parent} nodes={nodes} minVerifications={minVerifications}
          benchTotal={benchTotal} onSelect={setSelected} />
        <div className="record-info">{info}</div>
      </section>
    </>
  );
}
