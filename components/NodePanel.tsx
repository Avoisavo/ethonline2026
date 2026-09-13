"use client";

import { useState } from "react";
import { OBJECTIVES } from "@/lib/catalog";
import { STATUS_WORD, claimBp, counted, ignored, isBlocked, isRoot, objectiveOf, rootRerunBp, signedBp, tasks, wordOf } from "@/lib/format";
import type { ExportNode } from "@/lib/types";
import { Glyph } from "./Glyph";

interface Props {
  node: ExportNode;
  parent: ExportNode | null;
  nodes: ExportNode[];
  minVerifications: number;
  benchTotal: number;
  onSelect: (id: string) => void;
}

export function NodePanel({ node, parent, nodes, minVerifications, benchTotal, onSelect }: Props) {
  const p = node.detail.proposal;
  const c = counted(node);
  const ig = ignored(node);
  const root = isRoot(node, new Set(nodes.map((n) => n.id)));
  const rerun = root ? rootRerunBp(node, nodes) : null;

  return (
    <aside className="node-panel" aria-live="polite">
      <div className="np-head">
        <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} /></svg>
        <p className="eyebrow">{wordOf(node)} · {node.short}</p>
      </div>

      <h2 className="np-hyp">{node.hypothesis}</h2>

      <div className={`verdict v-${node.status}`}>
        <span className="code">{node.statusCode}</span>
        <p>{node.statusReason}</p>
      </div>

      {isBlocked(node) && (
        <div className="blocked">
          <span className="code">{node.detail.mechanical!.cls === "not-scored" ? "NOT SCORED YET" : "BLOCKED BEFORE MEASURING"} · {node.detail.mechanical!.cls}</span>
          <p>{node.detail.mechanical!.cls === "not-scored"
            ? "The change passed every check, but replay has no recorded answers for it. Score it live to get a real number."
            : node.detail.mechanical!.cls.startsWith("typecheck")
              ? "The change did not compile, so the benchmark never ran. The attempt is kept as a record."
              : "A guard refused the change, so the benchmark never ran. The attempt is kept as a record."}</p>
          <pre>{node.detail.mechanical!.evidence}</pre>
        </div>
      )}

      <dl className="facts">
        <div>
          <dt>Score</dt>
          <dd>
            {tasks(isBlocked(node) ? claimBp(node, nodes) : rerun ?? node.detail.claimedMedianBp, benchTotal)}
            <small>{isBlocked(node) ? "author claim · not scored yet" : rerun !== null ? `${rerun}bp · re-run by the keys that checked its child` : `${node.detail.claimedMedianBp}bp · author claim`}</small>
          </dd>
        </div>
        <div>
          <dt>Checked change</dt>
          <dd>{root ? "baseline" : signedBp(node.verifiedDeltaBp)}<small>{root ? "the first version has no parent" : "measured by other keys, never the author"}</small></dd>
        </div>
        <div><dt>Keys</dt><dd>{c} of {minVerifications}<small>{ig > 0 ? `${ig} ignored, reason below` : "distinct keys, counted"}</small></dd></div>
        <div><dt>Cost</dt><dd>{node.costs.tokensPerTask.toLocaleString("en")}<small>tokens per task, median</small></dd></div>
      </dl>

      <div className="np-block">
        <h3>How it could be proven wrong</h3>
        {p.falsifiedIf && <p className="muted"><b>Wrong if:</b> {p.falsifiedIf}</p>}
        <p className="tags">
          {!root && <span>aims at {objectiveOf(node)}</span>}
          <span>area {p.primaryArea}</span>
          <span>idea {p.motif}</span>
          {!node.showcase && <span className="badge">{node.mode.toUpperCase()}</span>}
        </p>
      </div>

      {parent && (
        <p className="parent-link">
          Copied from <button type="button" onClick={() => onSelect(parent.id)}>{parent.short}</button>, then changed one idea.
        </p>
      )}

      <div className="np-block">
        <h3>Checks by other keys ({node.verifications.length})</h3>
        {node.verifications.length === 0 && (
          <p className="muted">{root ? "The first version is never checked directly. Keys re-run it when they check its children." : "No key has checked this version yet. The author cannot check their own work."}</p>
        )}
        <ul className="checks">
          {node.verifications.map((v) => (
            <li key={v.reportId} className={v.counted ? "check counted" : "check ignored"}>
              <div className="check-top">
                <span className="check-state">{v.counted ? "COUNTED" : "IGNORED"}</span>
                <code>{v.runnerLabel || `key ${v.runner.slice(0, 8)}`}</code>
              </div>
              <p>
                Parent {tasks(v.parent.medianBp, v.parent.total)} → this {tasks(v.candidate.medianBp, v.candidate.total)} ·{" "}
                <b>{signedBp(v.deltaMedianBp)}</b> · {v.runs} runs each
              </p>
              {!v.counted && v.ignoredWhy && <p className="why">{v.ignoredWhy}</p>}
            </li>
          ))}
        </ul>
      </div>

      <Fork parentId={node.short} area={p.primaryArea} />

      {node.diff.trim() && (
        <details className="np-block diff">
          <summary>Show the change</summary>
          <pre>{node.diff}</pre>
        </details>
      )}
    </aside>
  );
}

/** Branch from this version toward your own direction. Prints the real CLI command. */
function Fork({ parentId, area }: { parentId: string; area: string }) {
  const [direction, setDirection] = useState(OBJECTIVES[0]!);
  const [copied, setCopied] = useState(false);
  const motif = direction.replace(/\s+/g, "-");
  const cmd = `pnpm petri propose --parent ${parentId} --area ${area} --motif ${motif} \\\n  --hypothesis "This change improves ${direction}, because ..."`;
  return (
    <div className="np-block fork">
      <h3>Fork this version</h3>
      <p className="muted">Copy it, change one idea toward your own goal, and submit it. Your fork becomes a new branch.</p>
      <label className="fork-row" htmlFor={`fork-dir-${parentId}`}>
        <span>Direction</span>
        <select id={`fork-dir-${parentId}`} value={direction} onChange={(e) => { setDirection(e.target.value); setCopied(false); }}>
          {OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <pre className="fork-cmd">{cmd}</pre>
      <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(cmd); setCopied(true); }}>
        {copied ? "Copied" : "Copy command"}
      </button>
    </div>
  );
}
