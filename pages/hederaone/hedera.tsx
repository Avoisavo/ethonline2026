// pages/hedera.tsx — MARS demo. Generate an agent → it creates a Hedera account, registers that
// account's EVM address in World AgentBook (scan the QR), then finishes (voting/review/profile/log).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect } from "react";
import Head from "next/head";
import { QRCodeSVG } from "qrcode.react";

const API = "/api/hederaone/hedera";
const hs = (kind: "account" | "topic", id: string) => `https://hashscan.io/testnet/${kind}/${id}`;
const A = ({ kind, id, label }: { kind: "account" | "topic"; id: string; label?: string }) => (
  <a className="font-mono text-blue-600 hover:underline" target="_blank" rel="noreferrer" href={hs(kind, id)}>{label ?? id} ↗</a>
);

async function call(body: Record<string, any>): Promise<any> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
function links(obj: any, key = "", out: { label: string; href: string }[] = []) {
  if (typeof obj === "string") {
    if (/^0\.0\.\d+$/.test(obj)) {
      const k = key.toLowerCase();
      const kind = /account/.test(k) ? "account" : /topic|registry|profile/.test(k) ? "topic" : "";
      if (kind) out.push({ label: `${key}: ${obj}`, href: hs(kind as any, obj) });
    } else if (/^0x[0-9a-fA-F]{40}$/.test(obj)) {
      out.push({ label: `${key}: ${obj}`, href: hs("account", obj) });
    }
  } else if (Array.isArray(obj)) obj.forEach((v) => links(v, key, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) links(v, k, out);
  return out;
}
function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />;
}

type Role = "user" | "auditor";
type Agent = { account: string; role: Role; worldVerified?: boolean; score?: number; evmAddress?: string; profileTopicId?: string; votingTopicId?: string; reviewTopicId?: string };
type ReviewSummary = { count: number; avg: number; reviews: { reviewer: string; rating: number; comment?: string; timestamp: string }[] };
type History = { agents: any[]; humans: any[]; jobs: any[] };

export default function Demo() {
  const [registryTopicId, setRegistry] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { rating: number; comment: string }>>({});
  const [reviews, setReviews] = useState<Record<string, ReviewSummary>>({});
  const [history, setHistory] = useState<History | null>(null);
  const [steps, setSteps] = useState<{ id: number; label: string; status: "running" | "done" | "error" }[]>([]);
  const [scanQR, setScanQR] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);
  const stepId = useRef(0);
  const didInit = useRef(false);
  const [log, setLog] = useState<{ label: string; data: any }[]>([]);

  const ready = !!registryTopicId;
  const running = steps.find((s) => s.status === "running");
  const busy = !!running || spawning;
  const push = (label: string, data: any) => setLog((l) => [{ label, data }, ...l].slice(0, 14));
  const draft = (a: string) => drafts[a] ?? { rating: 5, comment: "" };
  const setDraft = (a: string, d: Partial<{ rating: number; comment: string }>) => setDrafts((s) => ({ ...s, [a]: { ...draft(a), ...d } }));

  async function run(label: string, body: Record<string, any>) {
    const id = ++stepId.current;
    setSteps((s) => [{ id, label, status: "running" as const }, ...s].slice(0, 10));
    try {
      const r = await call(body);
      push(label, r);
      setSteps((s) => s.map((x) => (x.id === id ? { ...x, status: r?.error ? "error" : "done" } : x)));
      return r;
    } catch (e) {
      setSteps((s) => s.map((x) => (x.id === id ? { ...x, status: "error" } : x)));
      throw e;
    }
  }

  async function loadHistory(reg?: string) {
    const id = reg ?? registryTopicId;
    if (!id) return;
    const r = await call({ action: "readMainRegistry", registryTopicId: id });
    if (r && !r.error) setHistory(r);
  }

  // On load: ensure the seeded main HCS (the persistent history).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    (async () => {
      const r = await run("ensure main HCS (seeded registry)", { action: "initMars" });
      if (r?.registryTopicId) {
        setRegistry(r.registryTopicId);
        setSeeded(!!r.seeded);
        loadHistory(r.registryTopicId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generate = stream: create account → register EVM in AgentBook (QR) → finish.
  async function spawn(role: Role) {
    const tag = `new ${role}`;
    setSpawning(true);
    setScanQR(null);
    const local: Record<string, number> = {};
    const onStep = (s: { step: string; status: "running" | "done"; label: string; id?: string }) => {
      if (s.step === "agentbook" && s.status === "done") setScanQR(null);
      if (s.status === "running") {
        const id = ++stepId.current;
        local[s.step] = id;
        setSteps((st) => [{ id, label: `${tag} · ${s.label}`, status: "running" as const }, ...st].slice(0, 12));
      } else {
        const id = local[s.step];
        setSteps((st) => st.map((x) => (x.id === id ? { ...x, status: "done", label: `${tag} · ${s.label}${s.id ? ` → ${s.id}` : ""}` } : x)));
      }
    };
    try {
      const res = await fetch("/api/hederaone/register-agent-stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registryTopicId, role }) });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let result: any = null;
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.replace(/^data:\s?/, "").trim();
          if (!line) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "step") onStep(evt);
          else if (evt.type === "scan") setScanQR(evt.link);
          else if (evt.type === "done") { result = evt.result; push(`register ${role}`, evt.result); }
          else if (evt.type === "error") push(`register ${role}`, evt);
        }
      }
      if (result?.account) {
        setAgents((a) => [...a, { account: result.account, role, worldVerified: result.worldVerified, evmAddress: result.evmAddress, profileTopicId: result.profileTopicId, votingTopicId: result.votingTopicId, reviewTopicId: result.reviewTopicId }]);
        loadHistory();
        setTimeout(() => loadHistory(), 6000);
      }
    } catch (e) {
      push(`register ${role}`, { error: e instanceof Error ? e.message : "stream failed" });
    } finally {
      setScanQR(null);
      setSpawning(false);
    }
  }

  async function vote(a: Agent, good: boolean) {
    await run(`${good ? "👍" : "👎"} ${a.account}`, { action: good ? "voteGood" : "voteBad", topicId: a.votingTopicId, target: a.account });
  }
  async function score(a: Agent) {
    const r = await run(`score ${a.account}`, { action: "reputationScore", topicId: a.votingTopicId });
    const net = r?.scores?.[a.account]?.net;
    if (net != null) setAgents((al) => al.map((x) => (x.account === a.account ? { ...x, score: net } : x)));
  }
  async function postReview(a: Agent) {
    const d = draft(a.account);
    await run(`review ${a.account} (${d.rating}★)`, { action: "postReview", topicId: a.reviewTopicId, target: a.account, reviewer: "operator", rating: d.rating, comment: d.comment, role: a.role });
    setDraft(a.account, { comment: "" });
  }
  async function showReviews(a: Agent) {
    const r = await run(`reviews of ${a.account}`, { action: "listReviews", topicId: a.reviewTopicId });
    const s = r?.reviews?.[a.account];
    if (s) setReviews((rv) => ({ ...rv, [a.account]: s }));
  }

  const btn = "rounded-md px-2 py-1 text-xs font-medium disabled:opacity-40";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Head><title>MARS · demo</title></Head>

      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-lg font-semibold">MARS <span className="text-slate-400">·</span> agent registry demo</h1>
        <p className="text-sm text-slate-500">Generate an agent → it makes a Hedera account, registers that EVM address in <b>World AgentBook</b> (scan the QR), then finishes. Hedera testnet.</p>
      </header>

      {steps.length > 0 && (
        <div className="border-b border-slate-200 bg-white px-6 py-2">
          <div className="mx-auto max-w-5xl space-y-1">
            {steps.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs">
                {s.status === "running" ? <Spinner /> : s.status === "done" ? <span className="text-green-600">✓</span> : <span className="text-red-600">✗</span>}
                <span className={s.status === "running" ? "font-medium text-slate-700" : s.status === "error" ? "text-red-600" : "text-slate-500"}>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600">
          {ready ? <span>main HCS <A kind="topic" id={registryTopicId} />{seeded && <span className="ml-1 text-slate-400">★ seeded</span>}</span> : <span className="flex items-center gap-1 text-amber-600"><Spinner /> ensuring main HCS…</span>}
          <span className="text-slate-400">each agent gets its own voting + review HCS</span>
        </div>
      </div>

      <main className="mx-auto max-w-5xl space-y-4 p-6">
        {/* AgentBook scan QR (shown mid-generate) */}
        {scanQR && (
          <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-center">
            <div className="mb-2 text-sm font-semibold text-amber-800">📱 Scan with the World App to register this agent in World AgentBook</div>
            <div className="inline-block rounded bg-white p-3"><QRCodeSVG value={scanQR} size={200} /></div>
            <div className="mt-2 flex items-center justify-center gap-1 text-xs text-amber-700"><Spinner /> waiting for verification…</div>
          </div>
        )}

        {/* MAIN HCS — recorded history */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Main HCS — recorded history</h2>
            {ready && <A kind="topic" id={registryTopicId} label={registryTopicId} />}
            <button onClick={() => loadHistory()} disabled={!ready || busy} className={`${btn} ml-auto border border-slate-300 bg-white hover:bg-slate-100`}>refresh</button>
          </div>
          {!history ? (
            <p className="text-xs text-slate-400">{ready ? "no records yet — Generate an agent, then refresh (mirror node lags a few seconds)." : "loading…"}</p>
          ) : (
            <div className="space-y-1 text-[11px]">
              {history.agents.map((a, i) => (
                <div key={`a${i}`} className="text-slate-600">
                  <span className={a.role === "auditor" ? "font-semibold text-purple-700" : "font-semibold text-blue-700"}>{a.role}</span> · <A kind="account" id={a.account} /> {a.world_verified ? "· World✓" : ""}
                </div>
              ))}
              {history.agents.length === 0 && <p className="text-slate-400">no agents yet (or still propagating)</p>}
            </div>
          )}
        </div>

        {/* generate */}
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Agents</h2>
          <button onClick={() => spawn("user")} disabled={!ready || busy} className={`${btn} ml-auto border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100`}>⚡ Generate user</button>
          <button onClick={() => spawn("auditor")} disabled={!ready || busy} className={`${btn} border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100`}>⚡ Generate auditor</button>
        </div>
        {ready && agents.length === 0 && <p className="text-xs text-slate-400">Press ⚡ Generate — it creates an account, registers its EVM in AgentBook (scan the QR), then logs an <code>agent_registered</code> into the main HCS.</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => (
            <div key={a.account} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${a.role === "auditor" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>{a.role}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${a.worldVerified ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{a.worldVerified ? "World ✓" : "unverified"}</span>
              </div>
              <div className="space-y-0.5 text-[11px] text-slate-500">
                <div>acct <A kind="account" id={a.account} />{a.score != null && <span className="ml-2 font-sans font-semibold text-slate-700">rep {a.score >= 0 ? "+" : ""}{a.score}</span>}</div>
                {a.evmAddress && <div>evm <A kind="account" id={a.evmAddress} label={`${a.evmAddress.slice(0, 10)}…`} /></div>}
                {a.profileTopicId && <div>profile HCS <A kind="topic" id={a.profileTopicId} /></div>}
                {a.votingTopicId && <div>voting HCS <A kind="topic" id={a.votingTopicId} /></div>}
                {a.reviewTopicId && <div>review HCS <A kind="topic" id={a.reviewTopicId} /></div>}
              </div>

              <div className="flex gap-1.5">
                <button onClick={() => vote(a, true)} disabled={busy} className={`${btn} border border-green-300 bg-green-50 text-green-700 hover:bg-green-100`}>👍 good</button>
                <button onClick={() => vote(a, false)} disabled={busy} className={`${btn} border border-red-300 bg-red-50 text-red-700 hover:bg-red-100`}>👎 bad</button>
                <button onClick={() => score(a)} disabled={busy} className={`${btn} border border-slate-300 bg-white hover:bg-slate-100`}>score</button>
              </div>

              <div className="flex items-center gap-1.5">
                <select value={draft(a.account).rating} onChange={(e) => setDraft(a.account, { rating: Number(e.target.value) })} className="rounded border border-slate-300 px-1 py-1 text-xs">
                  {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}★</option>)}
                </select>
                <input value={draft(a.account).comment} onChange={(e) => setDraft(a.account, { comment: e.target.value })} placeholder="review message…" className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" />
                <button onClick={() => postReview(a)} disabled={busy} className={`${btn} bg-slate-900 text-white hover:bg-slate-700`}>Post</button>
                <button onClick={() => showReviews(a)} disabled={busy} className={`${btn} border border-slate-300 bg-white hover:bg-slate-100`}>Reviews</button>
              </div>

              {reviews[a.account] && (
                <div className="rounded bg-slate-50 p-2 text-[11px]">
                  <div className="font-semibold">{reviews[a.account].avg}★ avg · {reviews[a.account].count} review(s)</div>
                  {reviews[a.account].reviews.map((rv, i) => (
                    <div key={i} className="text-slate-600">{rv.rating}★ {rv.comment} <span className="text-slate-400">— {rv.reviewer}</span></div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="pt-2">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Activity</h2>
          <div className="space-y-2">
            {log.length === 0 && <p className="text-xs text-slate-400">Responses appear here.</p>}
            {log.map((e, i) => (
              <details key={i} className="rounded-md border border-slate-200 bg-white p-2 text-xs">
                <summary className="cursor-pointer font-medium text-slate-700">{e.label}{e.data?.error && <span className="ml-2 text-red-600">✗ {String(e.data.error).slice(0, 60)}</span>}</summary>
                {links(e.data).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    {links(e.data).map((l, j) => <a key={j} href={l.href} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-blue-600 hover:underline">{l.label} ↗</a>)}
                  </div>
                )}
                <pre className="mt-1 max-h-60 overflow-auto font-mono text-[11px] text-slate-600">{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
