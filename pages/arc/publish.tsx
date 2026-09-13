// pages/arc/publish.tsx — AUTHOR flow: publish a PREMIUM, royalty-bearing skill.
//
// Minimal, author-friendly: the only decisions an author makes are (1) provide the skill
// (drag/drop files · paste · GitHub/URL/npm · or a demo), (2) set the royalty %.
// One "Publish" button then runs the
// whole on-chain pipeline automatically — approve → create+fund the Arc escrow audit job →
// auditor posts bond → real audit → release escrow → mint the Hedera VERIFIED NFT + a
// premium license, and list the skill. Fee/bond/Hedera-payout/Gateway live under "Advanced".
//
// Visual language: soft light theme + the --cell/--ink/--arc tokens (style block at the bottom).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import {
  ESCROW_ABI,
  ESCROW_ADDRESS,
  GATEWAY_WALLET,
  GATEWAY_WALLET_ABI,
  USDC_ABI,
  USDC_ADDRESS,
  USDC_DECIMALS,
  arcTestnet,
  explorerTx,
} from "@/lib/arc/escrow";
import ArcProviders from "@/components/arc/ArcProviders";

const API = "/api/hederaone/hedera";
const hashscan = (kind: "account" | "token" | "topic", id: string) => `https://hashscan.io/testnet/${kind}/${id}`;

async function call(body: Record<string, any>): Promise<any> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

const DEMO_SKILLS = [
  { ref: "safe-weather-skill", label: "Safe Weather — read-only weather lookup" },
  { ref: "price-checker.js", label: "Price Checker — token price oracle" },
];

// The publish pipeline, in the order it runs. Each becomes a row in the live checklist.
const STEPS = [
  { key: "approve", label: "Approve USDC for the escrow" },
  { key: "create", label: "Create the audit job (Arc escrow)" },
  { key: "fund", label: "Fund the audit fee" },
  { key: "bond", label: "Auditor posts its bond" },
  { key: "audit", label: "Run the security audit" },
  { key: "release", label: "Release escrow to the auditor" },
  { key: "mint", label: "Mint VERIFIED + list as premium" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];
type StepState = { status: "pending" | "running" | "done" | "error"; note?: string };

function Publish() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // wallet
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const onArc = chainId === arcTestnet.id;
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // author choices (the only things they set)
  const [royalty, setRoyalty] = useState(10);
  const price = "0.01"; // per-use price buyers pay

  // skill source — Upload (drag/drop) · Paste · GitHub/URL/npm · Demo
  const [srcMode, setSrcMode] = useState<"upload" | "paste" | "url" | "demo">("upload");
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteName, setPasteName] = useState("SKILL.md");
  const [urlRef, setUrlRef] = useState("");
  const [demoRef, setDemoRef] = useState(DEMO_SKILLS[0].ref);

  // advanced (sensible defaults — hidden by default)
  const [fee, setFee] = useState("0.1");
  const [bond, setBond] = useState("0.05");
  const [hederaId, setHederaId] = useState("");
  const [regAmt, setRegAmt] = useState("0.2");

  // infra
  const [agent, setAgent] = useState<{ address?: string } | null>(null);
  const [agentErr, setAgentErr] = useState<string | null>(null);
  const [registryTopicId, setRegistryTopicId] = useState("");
  const [gwBal, setGwBal] = useState<string | null>(null);
  const [reg, setReg] = useState<{ busy?: boolean; error?: string; done?: boolean; tx?: string }>({});

  // run state
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(() => Object.fromEntries(STEPS.map((s) => [s.key, { status: "pending" }])) as Record<StepKey, StepState>);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const usdcBal = useReadContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: !!address } });

  const fetchAgent = useCallback(async () => {
    try {
      const r = await fetch("/api/arc/agent");
      const d = await r.json();
      if (d.address) { setAgent(d); setAgentErr(null); }
      else setAgentErr(d.error || "auditor agent unavailable");
    } catch (e) { setAgentErr(e instanceof Error ? e.message : "auditor agent unavailable"); }
  }, []);
  const fetchGwBal = useCallback(async () => {
    if (!address) return setGwBal(null);
    try { const r = await fetch(`/api/arc/gateway-balance?address=${address}`); const d = await r.json(); setGwBal(d.available ?? "0"); } catch { setGwBal(null); }
  }, [address]);
  useEffect(() => { fetchAgent(); fetchGwBal(); }, [fetchAgent, fetchGwBal]);
  useEffect(() => { (async () => { const r = await call({ action: "initMars" }); if (r?.registryTopicId) setRegistryTopicId(r.registryTopicId); })(); }, []);

  const amt = (v: string) => parseUnits(v || "0", USDC_DECIMALS);
  const mark = (key: StepKey, status: StepState["status"], note?: string) => setSteps((s) => ({ ...s, [key]: { status, note } }));

  // ── skill-source ingestion ─────────────────────────────────────────
  const TEXT_RE = /\.(md|markdown|js|mjs|cjs|ts|tsx|json|py|txt|ya?ml|toml|sh|env|rb|go)$/i;
  const ingest = async (list: FileList | File[]) => {
    const out: { name: string; content: string }[] = [];
    for (const f of Array.from(list)) {
      const rel = (f as any).webkitRelativePath || f.name;
      if (!TEXT_RE.test(f.name) && f.name.toUpperCase() !== "SKILL.MD") continue;
      if (f.size > 200_000) continue;
      out.push({ name: rel, content: await f.text() });
    }
    if (out.length) setFiles((prev) => { const m = new Map(prev.map((p) => [p.name, p])); out.forEach((o) => m.set(o.name, o)); return Array.from(m.values()).slice(0, 40); });
  };
  const baseName = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
  const deriveName = (fs: { name: string }[]) => {
    const main = fs.find((f) => /skill\.md$/i.test(f.name)) ?? fs[0];
    const parts = main.name.split("/");
    return parts.length > 1 ? parts[0] : baseName(main.name) || "skill";
  };

  // Resolve whatever the author provided into { name, files } before any on-chain step.
  const getSource = async (): Promise<{ name: string; files: { name: string; content: string }[] }> => {
    if (srcMode === "upload") {
      if (!files.length) throw new Error("Add at least one skill file (SKILL.md, code, manifest).");
      return { name: deriveName(files), files };
    }
    if (srcMode === "paste") {
      if (!pasteText.trim()) throw new Error("Paste your skill source first.");
      const nm = (pasteName || "SKILL.md").trim();
      return { name: nm.replace(/\.[^.]+$/, "") || "skill", files: [{ name: nm, content: pasteText }] };
    }
    const ref = (srcMode === "url" ? urlRef : demoRef).trim();
    if (!ref) throw new Error("Enter a GitHub/raw URL or npm package.");
    const r = await call({ action: "resolveSkill", ref });
    if (r.error || !r.files?.length) throw new Error(r.error || "Could not fetch that skill.");
    return { name: r.name, files: r.files };
  };

  const hasSource = srcMode === "upload" ? files.length > 0 : srcMode === "paste" ? !!pasteText.trim() : srcMode === "url" ? !!urlRef.trim() : true;
  const ready = mounted && isConnected && onArc && hasSource && !running;

  // one-time: register the author's wallet with Circle Gateway so it can RECEIVE x402 royalties
  const registerGateway = async () => {
    if (!address || !publicClient) return;
    setReg({ busy: true });
    try {
      const a = parseUnits(regAmt || "0.2", USDC_DECIMALS);
      const approveHash = await writeContractAsync({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [GATEWAY_WALLET, a] });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      const depositHash = await writeContractAsync({ address: GATEWAY_WALLET, abi: GATEWAY_WALLET_ABI, functionName: "deposit", args: [USDC_ADDRESS, a], gas: 120000n });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
      setReg({ done: true, tx: depositHash }); fetchGwBal(); usdcBal.refetch();
    } catch (e) { const x = e as { shortMessage?: string; message?: string }; setReg({ error: x.shortMessage || x.message || "register failed" }); }
  };

  // The whole publish pipeline behind one button.
  const publishAll = async () => {
    if (!address || !publicClient) return;
    setErr(null); setResult(null); setRunning(true);
    setSteps(Object.fromEntries(STEPS.map((s) => [s.key, { status: "pending" }])) as Record<StepKey, StepState>);
    const wait = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });
    try {
      const feeUnits = amt(fee);
      const bondUnits = amt(bond);

      // 0 · resolve the author's skill source (upload / paste / URL / demo) — fail fast
      const src = await getSource();
      const skill = (src.name || "skill").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
      const content = src.files.map((f) => `=== ${f.name} ===\n${f.content}`).join("\n").slice(0, 8000);

      // 1 · approve (only if needed)
      mark("approve", "running");
      const allow = (await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "allowance", args: [address, ESCROW_ADDRESS] })) as bigint;
      if (allow < feeUnits) {
        const h = await writeContractAsync({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [ESCROW_ADDRESS, amt("1000")] });
        await wait(h);
      }
      mark("approve", "done");

      // 2 · create job (developer = you, auditor = the auditor agent)
      mark("create", "running");
      if (!agent?.address) throw new Error(agentErr || "auditor agent unavailable — set ARC_PRIVATE_KEY");
      const newId = Number(await publicClient.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "nextJobId" }));
      const ch = await writeContractAsync({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "createJob", args: [address, agent.address as `0x${string}`, feeUnits, bondUnits] });
      await wait(ch);
      mark("create", "done", `job #${newId}`);

      // 3 · fund the fee
      mark("fund", "running");
      await wait(await writeContractAsync({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "fundFee", args: [BigInt(newId), feeUnits] }));
      mark("fund", "done");

      // 4 · auditor posts bond (server-side, the auditor agent)
      mark("bond", "running");
      const br = await fetch("/api/arc/agent-post-bond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: newId }) });
      const bd = await br.json();
      if (!br.ok || !bd.ok) throw new Error(bd.error || "auditor could not post bond");
      mark("bond", "done");

      // 5 · run the real audit (on the author's actual source)
      mark("audit", "running");
      const created = await call({ action: "createTask", skill, content, requester: hederaId || "author", auditor: "ethonlineArc-premium-auditor", price: `${price} USDC`, registryTopicId });
      if (created.error || !created.taskTopicId) throw new Error(created.error || "could not create audit task");
      const aud = await call({ action: "runAudit", taskTopicId: created.taskTopicId, files: src.files, skill, registryTopicId });
      if (aud.error) throw new Error(aud.error);
      if (aud.verdict !== "SAFE") { mark("audit", "error", `verdict ${aud.verdict}`); throw new Error(`Audit verdict is ${aud.verdict} — this skill can't be published. Try a safe skill.`); }
      mark("audit", "done", `SAFE · trust ${aud.trustScore}`);

      // 6 · release escrow to the auditor (clean audit paid)
      mark("release", "running");
      await wait(await writeContractAsync({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "release", args: [BigInt(newId)] }));
      mark("release", "done");

      // 7 · mint VERIFIED + premium license + list
      mark("mint", "running");
      const pub = await call({
        action: "publishPremiumSkill",
        taskTopicId: created.taskTopicId,
        skill: aud.skill ?? skill,
        files: src.files,
        verdict: "SAFE",
        author: { hederaId: hederaId || null, evm: address, humanId: null },
        royaltyPct: royalty,
        price: `${price} USDC`,
        escrowJobId: newId,
        registryTopicId,
      });
      if (pub.error) throw new Error(pub.error);
      mark("mint", "done");
      setResult({ ...pub, taskTopicId: created.taskTopicId, jobId: newId });
      usdcBal.refetch();
    } catch (e) {
      const x = e as { shortMessage?: string; message?: string };
      setErr(x.shortMessage || x.message || String(e));
      setSteps((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.status === "running" ? { ...v, status: "error" } : v])) as Record<StepKey, StepState>);
    } finally { setRunning(false); }
  };

  const hint = !mounted ? "" : !isConnected ? "Connect your wallet to publish." : !onArc ? "Switch to Arc Testnet." : "";
  const anyStepShown = running || result || Object.values(steps).some((v) => v.status !== "pending");

  return (
    <div className="pub-page">
      <Head><title>ethonlineArc · publish a skill</title></Head>

      <div className="pub-wrap">
        <header className="pub-header">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="pub-h1">Publish a skill</h1>
              <p className="pub-sub">Get your skill audited, minted VERIFIED on Hedera, and earn a royalty every time an agent uses it.</p>
            </div>
          </div>
          {mounted && <ConnectButton showBalance={false} />}
        </header>

        <div className="pub-col">
          {/* publish */}
          <section className="pub-card">
            <StepHead n={1} title="Publish your skill" done={!!result} />

            <div className="pub-field">
              <span className="pub-label">Your skill</span>
              <div className="pub-tabs">
                {([["upload", "Upload"], ["paste", "Paste"], ["url", "GitHub / URL"], ["demo", "Demo"]] as const).map(([m, l]) => (
                  <button key={m} type="button" disabled={running} onClick={() => setSrcMode(m)} className={`pub-tab ${srcMode === m ? "pub-tab--on" : ""}`}>{l}</button>
                ))}
              </div>

              {srcMode === "upload" && (
                <div className="mt-2">
                  <label
                    htmlFor="pub-file"
                    className={`pub-drop ${dragOver ? "pub-drop--over" : ""}`}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) ingest(e.dataTransfer.files); }}
                  >
                    <input id="pub-file" type="file" multiple hidden onChange={(e) => { if (e.target.files) ingest(e.target.files); e.currentTarget.value = ""; }} />
                    <p className="t-ink2" style={{ fontSize: 13 }}>Drag &amp; drop your <strong>SKILL.md</strong>, code or manifest</p>
                    <p className="t-ink3" style={{ fontSize: 12 }}>or click to browse · .md .js .ts .json .py .yaml …</p>
                  </label>
                  {files.length > 0 && (
                    <div className="pub-chips">
                      {files.map((f) => (
                        <span key={f.name} className="pub-chip">
                          <span className="pub-code">{f.name}</span>
                          <button type="button" className="pub-chip-x" onClick={() => setFiles((p) => p.filter((x) => x.name !== f.name))}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {srcMode === "paste" && (
                <div className="flex flex-col gap-2 mt-2">
                  <input className="pub-input" style={{ width: 220 }} value={pasteName} onChange={(e) => setPasteName(e.target.value)} disabled={running} placeholder="SKILL.md" />
                  <textarea className="pub-input pub-textarea" value={pasteText} onChange={(e) => setPasteText(e.target.value)} disabled={running} placeholder={"# My Skill\n\nPaste your SKILL.md, MCP manifest, or code here…"} />
                </div>
              )}

              {srcMode === "url" && (
                <input className="pub-input mt-2" value={urlRef} onChange={(e) => setUrlRef(e.target.value)} disabled={running} placeholder="github.com/user/repo/blob/main/SKILL.md · a raw URL · or an npm package" />
              )}

              {srcMode === "demo" && (
                <select className="pub-input mt-2" value={demoRef} onChange={(e) => setDemoRef(e.target.value)} disabled={running}>
                  {DEMO_SKILLS.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
                </select>
              )}

              {(srcMode === "upload" && files.length > 0) && (
                <p className="t-ink3" style={{ fontSize: 12, marginTop: 6 }}>Publishes as <span className="t-ink">{deriveName(files)}</span> · {files.length} file{files.length > 1 ? "s" : ""}</p>
              )}
            </div>

            <label className="pub-field mt-3">
              <span className="pub-label">Your royalty — <span className="t-arc" style={{ fontWeight: 700 }}>{royalty}%</span> of every use</span>
              <input type="range" min={1} max={50} value={royalty} onChange={(e) => setRoyalty(Number(e.target.value))} disabled={running} className="pub-range" />
            </label>

            <button onClick={publishAll} disabled={!ready} className="pub-btn pub-btn--arc pub-publish mt-4">
              {running ? "Publishing…" : "Publish skill"}
            </button>
            {hint && <span className="t-ink3 ml-3" style={{ fontSize: 12 }}>{hint}</span>}

            {/* live progress */}
            {anyStepShown && (
              <ul className="pub-steps mt-4">
                {STEPS.map((s) => {
                  const st = steps[s.key];
                  const icon = st.status === "done" ? "✓" : st.status === "error" ? "✕" : st.status === "running" ? "spin" : "○";
                  const tone = st.status === "done" ? "t-safe" : st.status === "error" ? "t-danger" : st.status === "running" ? "t-comm" : "t-ink3";
                  return (
                    <li key={s.key} className="flex items-center gap-2">
                      {icon === "spin" ? <span className="pub-spin" /> : <span className={tone} style={{ width: 14, textAlign: "center" }}>{icon}</span>}
                      <span className={st.status === "pending" ? "t-ink3" : "t-ink2"} style={{ fontSize: 13 }}>{s.label}</span>
                      {st.note && <span className="t-ink3" style={{ fontSize: 12 }}>· {st.note}</span>}
                    </li>
                  );
                })}
              </ul>
            )}

            {err && <p className="pub-note pub-note--danger">{err}</p>}
            {agentErr && !agent?.address && <p className="t-warn mt-2" style={{ fontSize: 12 }}>Heads up: the auditor agent isn&apos;t loaded ({agentErr}). Set <code className="pub-code">ARC_PRIVATE_KEY</code> in <code className="pub-code">hardhat/arc/.env</code> and restart.</p>}

            {/* result */}
            {result && (
              <div className="pub-note pub-note--safe mt-3 flex flex-col gap-1.5">
                <p><strong>✓ {result.skill} is live</strong> — verified & earning {result.royaltyPct}% royalty.</p>
                {result.verified?.tokenId && <p className="t-ink2">VERIFIED badge: <a className="pub-code pub-link" href={hashscan("token", result.verified.tokenId)} target="_blank" rel="noreferrer">{result.verified.tokenId}#{result.verified.serial} ↗</a></p>}
                {result.license?.tokenId && (
                  <p className="t-ink2">License token: <a className="pub-code pub-link" href={hashscan("token", result.license.tokenId)} target="_blank" rel="noreferrer">{result.license.tokenId} ↗</a>{result.license.royalty ? <span className="t-ink3"> · Hedera royalty {result.license.royalty.numerator}/{result.license.royalty.denominator}</span> : <span className="t-ink3"> · Arc royalty only</span>}</p>
                )}
                <p className="t-ink2" style={{ borderTop: "1px solid var(--hair-soft)", paddingTop: 8, marginTop: 4 }}>
                  Agents pay {price} USDC per use on the <Link className="pub-link" href="/arc/test">marketplace</Link> (job #{result.jobId}) — {result.royaltyPct}% comes to you.
                </p>
              </div>
            )}

            {/* advanced */}
            <details className="pub-adv mt-4">
              <summary className="pub-label" style={{ cursor: "pointer" }}>Advanced settings</summary>
              <div className="flex flex-col gap-3 mt-3">
                <div className="flex flex-wrap items-end gap-4">
                  <label className="pub-field"><span className="pub-label">Audit fee (USDC)</span><input className="pub-input" style={{ width: 90 }} value={fee} onChange={(e) => setFee(e.target.value)} disabled={running} /></label>
                  <label className="pub-field"><span className="pub-label">Auditor bond (USDC)</span><input className="pub-input" style={{ width: 90 }} value={bond} onChange={(e) => setBond(e.target.value)} disabled={running} /></label>
                </div>
                <label className="pub-field">
                  <span className="pub-label">Hedera payout account <span style={{ textTransform: "none", fontWeight: 400 }} className="t-ink3">— optional, adds a native Hedera royalty</span></span>
                  <input className="pub-input" style={{ width: 200 }} placeholder="0.0.xxxxx" value={hederaId} onChange={(e) => setHederaId(e.target.value.trim())} disabled={running} />
                </label>
                <div className="flex flex-wrap items-end gap-3" style={{ borderTop: "1px solid var(--hair-soft)", paddingTop: 12 }}>
                  <label className="pub-field"><span className="pub-label">Set up payouts (one-time) · deposit USDC</span><input className="pub-input" style={{ width: 90 }} value={regAmt} onChange={(e) => setRegAmt(e.target.value)} /></label>
                  <button onClick={registerGateway} disabled={reg.busy || !onArc} className="pub-btn pub-btn--ghost">{reg.busy ? "setting up…" : "Register to receive x402"}</button>
                  <span className="t-ink3" style={{ fontSize: 12 }}>Gateway balance: {gwBal ?? "…"} USDC{usdcBal.data != null ? ` · wallet ${formatUnits(usdcBal.data as bigint, USDC_DECIMALS)}` : ""}</span>
                  {reg.done && reg.tx && <a className="pub-link" style={{ fontSize: 12 }} href={explorerTx(reg.tx)} target="_blank" rel="noreferrer">tx ↗</a>}
                </div>
                {reg.error && <p className="pub-note pub-note--danger">{reg.error}</p>}
              </div>
            </details>
          </section>

          {mounted && isConnected && !onArc && (
            <button onClick={() => switchChain({ chainId: arcTestnet.id })} className="pub-btn pub-btn--arc" style={{ alignSelf: "flex-start" }}>Switch to Arc Testnet</button>
          )}
        </div>
      </div>

      <style jsx global>{`
        :root {
          --space: #eef0f4;
          --cell: rgba(255, 255, 255, 0.78);
          --inset: #f1f3f7;
          --ink: #1b1d24;
          --ink-2: #565b66;
          --ink-3: #9498a2;
          --hair: rgba(0, 0, 0, 0.12);
          --hair-soft: rgba(0, 0, 0, 0.06);
          --arc: #c2542a;
          --safe: #1f9d63;
          --danger: #d23f2e;
          --warn: #b9780f;
          --comm: #2f6fd0;
          --sans: "Inter", system-ui, -apple-system, sans-serif;
          --code: "Geist Mono", ui-monospace, "SF Mono", monospace;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; }
        body {
          background: radial-gradient(120% 90% at 28% 12%, #ffffff 0%, var(--space) 62%);
          color: var(--ink);
          font-family: var(--sans);
          font-variant-numeric: tabular-nums;
          -webkit-font-smoothing: antialiased;
        }
        .pub-page { min-height: 100vh; }
        .pub-wrap { max-width: 600px; margin: 0 auto; padding: 28px 22px 64px; }
        .pub-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; padding-bottom: 18px; margin-bottom: 20px; border-bottom: 1px solid var(--hair); }
        .pub-h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
        .pub-sub { margin: 3px 0 0; max-width: 420px; font-size: 12.5px; line-height: 1.5; color: var(--ink-2); }
        .pub-col { display: flex; flex-direction: column; gap: 16px; }

        .pub-card { background: var(--cell); border: 1px solid var(--hair); border-radius: 16px; padding: 20px; backdrop-filter: blur(8px); }
        .pub-field { display: flex; flex-direction: column; gap: 6px; }

        .pub-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-3); }
        .pub-code { font-family: var(--code); font-size: 12px; }
        .t-ink { color: var(--ink); } .t-ink2 { color: var(--ink-2); } .t-ink3 { color: var(--ink-3); }
        .t-arc { color: var(--arc); } .t-safe { color: var(--safe); } .t-danger { color: var(--danger); } .t-warn { color: var(--warn); } .t-comm { color: var(--comm); }
        .pub-link { color: var(--comm); } .pub-link:hover { text-decoration: underline; }

        .pub-input { background: #fff; border: 1px solid var(--hair); border-radius: 9px; padding: 9px 11px; font-size: 13px; color: var(--ink); font-family: var(--sans); outline: none; }
        .pub-input:focus { border-color: var(--comm); box-shadow: 0 0 0 3px rgba(47, 111, 208, 0.12); }
        .pub-range { accent-color: var(--arc); width: 100%; max-width: 320px; }
        .pub-textarea { width: 100%; min-height: 140px; resize: vertical; font-family: var(--code); font-size: 12px; line-height: 1.5; }

        .pub-tabs { display: inline-flex; gap: 2px; padding: 3px; background: var(--inset); border: 1px solid var(--hair); border-radius: 10px; }
        .pub-tab { border: none; background: transparent; color: var(--ink-2); font-size: 12.5px; font-weight: 600; padding: 6px 12px; border-radius: 7px; cursor: pointer; }
        .pub-tab:disabled { opacity: 0.5; cursor: default; }
        .pub-tab--on { background: #fff; color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

        .pub-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; text-align: center; padding: 22px; border: 1.5px dashed var(--hair); border-radius: 12px; background: rgba(255,255,255,0.5); cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
        .pub-drop:hover { border-color: var(--ink-3); }
        .pub-drop--over { border-color: var(--arc); background: rgba(194,84,42,0.06); }
        .pub-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        .pub-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; background: #fff; border: 1px solid var(--hair); border-radius: 8px; }
        .pub-chip-x { border: none; background: transparent; color: var(--ink-3); font-size: 15px; line-height: 1; cursor: pointer; padding: 0 2px; }
        .pub-chip-x:hover { color: var(--danger); }

        .pub-btn { border: 1px solid transparent; border-radius: 10px; padding: 9px 16px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer; transition: filter 0.15s ease, background 0.15s ease; }
        .pub-btn:disabled { opacity: 0.4; cursor: default; }
        .pub-btn--arc { background: var(--arc); }
        .pub-btn--arc:hover:not(:disabled) { filter: brightness(1.08); }
        .pub-btn--ghost { background: #fff; color: var(--ink); border-color: var(--hair); }
        .pub-btn--ghost:hover:not(:disabled) { background: var(--inset); }
        .pub-publish { padding: 11px 22px; font-size: 14px; }

        .pub-steps { display: flex; flex-direction: column; gap: 7px; padding: 12px 14px; border-radius: 10px; background: var(--inset); }
        .pub-spin { width: 13px; height: 13px; border-radius: 999px; border: 2px solid rgba(47,111,208,0.25); border-top-color: var(--comm); animation: pubspin 0.7s linear infinite; }
        @keyframes pubspin { to { transform: rotate(360deg); } }

        .pub-note { border-radius: 10px; padding: 11px 13px; font-size: 13px; margin-top: 8px; }
        .pub-note--danger { background: rgba(210, 63, 46, 0.08); border: 1px solid rgba(210, 63, 46, 0.3); color: var(--danger); }
        .pub-note--safe { background: rgba(31, 157, 99, 0.1); border: 1px solid rgba(31, 157, 99, 0.32); color: var(--ink); }

        .pub-adv > summary { list-style: none; user-select: none; }
        .pub-adv > summary::-webkit-details-marker { display: none; }
        .pub-adv > summary::before { content: "▸ "; color: var(--ink-3); }
        .pub-adv[open] > summary::before { content: "▾ "; }

        .pub-step { display: flex; align-items: center; justify-content: center; height: 24px; width: 24px; border-radius: 999px; font-size: 12px; font-weight: 700; flex: none; }
        .pub-step--done { background: var(--safe); color: #fff; }
        .pub-step--idle { background: var(--inset); color: var(--ink-3); border: 1px solid var(--hair); }
      `}</style>
    </div>
  );
}

function StepHead({ n, title, done }: { n: number; title: string; done?: boolean }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className={`pub-step ${done ? "pub-step--done" : "pub-step--idle"}`}>{done ? "✓" : n}</span>
      <p className="t-ink" style={{ fontSize: 15, fontWeight: 600 }}>{title}</p>
    </div>
  );
}

export default function ArcPublishPage() {
  return (
    <ArcProviders>
      <Publish />
    </ArcProviders>
  );
}
