"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IDKitResult, RpContext } from "@worldcoin/idkit";

import type { Decision } from "@/lib/selfie-check/policy";
import type { ConsoleState } from "@/lib/selfie-check/state";
import {
  CheckTrace,
  Field,
  Json,
  Panel,
  Pill,
  TIER_STYLES,
  formatAge,
  relativeTime,
} from "./ui";

/* ---------------------------------------------------------------- api types */

/** Derived from the server-side builder so the two can't drift. */
type Scenario = ConsoleState["scenarios"][number];

type PreflightCheck = {
  id: string;
  label: string;
  status: "ok" | "blocked" | "unknown";
  detail: string;
  fix?: string;
  code?: string;
};

type VerifyResponse =
  | {
      ok: true;
      source: "mock" | "live";
      scenarioId: string | null;
      continuityEvent:
        | "anchor_created"
        | "continuity_confirmed"
        | "continuity_broken";
      credential: {
        identifier: string;
        nullifier: string;
        nullifierShort: string;
        merkle_root: string;
        signal_hash: string | null;
        proofPreview: string;
        protocol_version: string;
        environment: string;
      };
      verify: {
        status: number | null;
        request: Record<string, unknown>;
        response: unknown;
        note?: string;
      };
      account: {
        continuity: string;
        continuityBreaks: number;
        anchorShort: string;
        lastShort: string;
      };
      decision: Decision | null;
    }
  | { ok: false; errorCode: string; detail: string; scenarioId: string | null };

/* ------------------------------------------------------------ capture flow */

/**
 * Stages of the relying-party journey the sandbox guide describes: request
 * handoff, consent, capture, enrollment/matching, proof generation, delivery.
 * Which stages appear depends on the sandbox user state being simulated.
 */
const STAGES: Record<string, string[]> = {
  hot: ["Request handoff", "Consent", "Capture", "Face match", "Proof"],
  cold: [
    "Install World App",
    "Create account",
    "Request handoff",
    "Consent",
    "Capture",
    "Enroll Selfie Check",
    "Proof",
  ],
  semi_cold: [
    "Reinstall World App",
    "Recover account",
    "Request handoff",
    "Consent",
    "Capture",
    "Face match",
    "Proof",
  ],
};

const GROUP_LABELS: Record<Scenario["group"], string> = {
  success: "Happy paths",
  continuity: "Continuity",
  freshness: "Freshness & expiry",
  error: "Error codes",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** IDKit pulls in WASM, so only load it when live credentials are configured. */
const LiveSelfieCheck = dynamic(() => import("./live-widget"), { ssr: false });

type LiveContext = {
  app_id: `app_${string}`;
  action: string;
  rp_context: RpContext;
  signal: string;
};

/* ------------------------------------------------------------------ console */

export default function FaceConsole({
  initialState,
}: {
  initialState: ConsoleState;
}) {
  const [state, setState] = useState<ConsoleState>(initialState);
  const [scenarioId, setScenarioId] = useState("hot_same_human");
  const [proof, setProof] = useState<VerifyResponse | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [stageList, setStageList] = useState<string[]>([]);
  const [attempts, setAttempts] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [showRaw, setShowRaw] = useState(false);
  /** In live mode, fall back to the local engine on demand — Selfie Check is
   *  feature-flagged per app, so `feature_unavailable` is a likely first
   *  response and the scenarios stay the only way to exercise the policy. */
  const [simulate, setSimulate] = useState(false);
  const [pre, setPre] = useState<PreflightCheck[] | null>(null);
  const [preBusy, setPreBusy] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [liveCtx, setLiveCtx] = useState<LiveContext | null>(null);
  const running = useRef(false);
  const pendingIntent = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/selfie-check/state", { cache: "no-store" });
    setState((await res.json()) as ConsoleState);
  }, []);

  // Keep relative ages ticking so freshness windows visibly decay.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const scenario = useMemo(
    () => state.scenarios.find((s) => s.id === scenarioId),
    [state, scenarioId],
  );

  const grouped = useMemo(() => {
    const groups: [Scenario["group"], Scenario[]][] = [
      ["success", []],
      ["continuity", []],
      ["freshness", []],
      ["error", []],
    ];
    for (const s of state.scenarios) {
      groups.find(([g]) => g === s.group)?.[1].push(s);
    }
    return groups.filter(([, list]) => list.length > 0);
  }, [state]);

  /** Forward a result to the server and fold the decision back into the UI. */
  const submit = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/selfie-check/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as VerifyResponse;
      setProof(data);
      if (data.ok && data.decision) {
        setAttempts((prev) => ({
          ...prev,
          [data.decision!.action.id]: data.decision!,
        }));
      }
      await refresh();
    },
    [refresh],
  );

  /** Live path: mint a fresh rp_context, then open the real IDKit widget. */
  const openLive = useCallback(async (intent?: string) => {
    pendingIntent.current = intent;
    setProof(null);
    const res = await fetch("/api/selfie-check/context", { method: "POST" });
    const ctx = (await res.json()) as LiveContext & { app_id: string | null };
    if (!ctx.app_id) {
      setProof({
        ok: false,
        errorCode: "unknown_rp",
        detail: "Server returned no app_id — check WORLD_APP_ID.",
        scenarioId: null,
      });
      return;
    }
    setLiveCtx(ctx as LiveContext);
    setLiveOpen(true);
  }, []);

  const runCheck = useCallback(
    async (intent?: string) => {
      if (running.current) return;
      if (state.mode === "live" && !simulate) {
        await openLive(intent);
        return;
      }
      running.current = true;
      setBusy(true);
      setProof(null);

      const sc = state.scenarios.find((s) => s.id === scenarioId);
      const stages = sc?.errorCode
        ? ["Request handoff", "Consent", "Capture"]
        : (STAGES[sc?.userState ?? "hot"] ?? STAGES.hot);
      setStageList(stages);

      try {
        for (const s of stages) {
          setStage(s);
          await sleep(300);
        }
        await submit({ scenarioId, intent });
      } finally {
        setStage(null);
        setBusy(false);
        running.current = false;
      }
    },
    [scenarioId, state, simulate, openLive, submit],
  );

  const attempt = useCallback(
    async (actionId: string) => {
      const res = await fetch("/api/selfie-check/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      const data = (await res.json()) as { ok: boolean; decision?: Decision };
      if (data.decision) {
        setAttempts((prev) => ({ ...prev, [actionId]: data.decision! }));
      }
      await refresh();
    },
    [refresh],
  );

  const runPreflight = useCallback(async () => {
    setPreBusy(true);
    try {
      const res = await fetch("/api/selfie-check/preflight", {
        cache: "no-store",
      });
      const data = (await res.json()) as { checks: PreflightCheck[] };
      setPre(data.checks);
    } finally {
      setPreBusy(false);
    }
  }, []);

  const reset = useCallback(async () => {
    await fetch("/api/selfie-check/reset", { method: "POST" });
    setProof(null);
    setAttempts({});
    await refresh();
  }, [refresh]);

  const { account } = state;
  const continuityTone =
    account.continuity === "intact"
      ? "good"
      : account.continuity === "broken"
        ? "bad"
        : "neutral";

  const daysLeft =
    account.credentialExpiresAt != null
      ? Math.floor((account.credentialExpiresAt - now) / 86400000)
      : null;

  const liveActive = state.mode === "live" && !simulate;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      {liveCtx && state.mode === "live" ? (
        <LiveSelfieCheck
          appId={liveCtx.app_id}
          action={liveCtx.action}
          rpContext={liveCtx.rp_context}
          signal={liveCtx.signal}
          open={liveOpen}
          onOpenChange={setLiveOpen}
          onResult={(result: IDKitResult) =>
            void submit({ result, intent: pendingIntent.current })
          }
          onFailure={(code: string) =>
            setProof({
              ok: false,
              errorCode: code,
              detail:
                code === "feature_unavailable"
                  ? "Selfie Check is not enabled for this app_id yet. Request the beta flag, or use Simulate to exercise the policy meanwhile."
                  : "World App returned this error code.",
              scenarioId: null,
            })
          }
        />
      ) : null}
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* ------------------------------------------------------- header */}
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
              Continuity Gate
            </h1>
            <Pill tone={state.mode === "live" ? "good" : "info"}>
              {state.mode === "live" ? "live credentials" : "mock engine"}
            </Pill>
            <Pill>selfie · id 11</Pill>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
            Selfie Check is low-friction and{" "}
            <span className="text-zinc-200">medium-assurance</span> — it does not
            promise one-person-one-account, so this demo does not use it as a
            personhood oracle. It uses the two things it is genuinely good at: a{" "}
            <span className="text-zinc-200">continuity</span> signal (the same
            human re-verifying yields the same nullifier) and a{" "}
            <span className="text-zinc-200">freshness</span> signal (
            <code className="font-mono text-xs text-zinc-300">max_age</code> per
            action tier). A 90-day credential is not a 90-day session.
          </p>
          {state.mode === "mock" && state.missingEnv.length > 0 ? (
            <p className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs leading-relaxed text-sky-200/80">
              Running on the local proof engine — Selfie Check is access-gated
              beta. Set{" "}
              <code className="font-mono">{state.missingEnv.join(", ")}</code> in{" "}
              <code className="font-mono">.env.local</code> to switch to the real
              IDKit widget and the live verify endpoint. Payload shapes and the
              policy path are identical either way.
            </p>
          ) : null}
        </header>

        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          {/* ------------------------------------------------ left column */}
          <div className="space-y-4">
            <Panel
              title="Human anchor"
              hint="The nullifier captured at enrollment, and how the latest proof compares to it."
              right={
                <button
                  onClick={reset}
                  className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                >
                  Reset demo
                </button>
              }
            >
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="text-2xl font-semibold tracking-tight text-zinc-50">
                  {account.continuity === "intact"
                    ? "Continuity intact"
                    : account.continuity === "broken"
                      ? "Continuity break"
                      : "No anchor yet"}
                </span>
                <Pill tone={continuityTone}>{account.continuity}</Pill>
              </div>
              <dl>
                <Field
                  label="anchor nullifier"
                  value={account.anchorShort}
                  tone={account.anchorShort === "—" ? "muted" : "default"}
                />
                <Field
                  label="latest nullifier"
                  value={account.lastShort}
                  tone={
                    account.continuity === "broken"
                      ? "bad"
                      : account.lastShort === "—"
                        ? "muted"
                        : "good"
                  }
                />
                <Field
                  label="anchored"
                  value={relativeTime(account.anchoredAt, now)}
                  tone="muted"
                />
                <Field
                  label="proof age"
                  value={formatAge(account.proofAgeSeconds)}
                  tone={
                    account.proofAgeSeconds == null
                      ? "muted"
                      : account.proofAgeSeconds > 604800
                        ? "bad"
                        : account.proofAgeSeconds > 3600
                          ? "warn"
                          : "good"
                  }
                />
                <Field
                  label="credential validity"
                  value={
                    daysLeft == null
                      ? "—"
                      : daysLeft < 0
                        ? `expired ${-daysLeft}d ago`
                        : `${daysLeft}d of 90 left`
                  }
                  tone={
                    daysLeft == null
                      ? "muted"
                      : daysLeft < 0
                        ? "bad"
                        : daysLeft <= 14
                          ? "warn"
                          : "good"
                  }
                />
                <Field label="action (must be stable)" value={state.action} />
              </dl>
              {account.continuity === "broken" ? (
                <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs leading-relaxed text-rose-200/80">
                  A different human passed a genuine liveness check on this
                  account. Liveness succeeded; continuity did not. Because the
                  credential is medium-assurance, the right response is
                  escalation — not another selfie.
                </p>
              ) : null}
            </Panel>

            <Panel
              title="Gated actions"
              hint="Each tier demands its own proof age. The window is sent to the verify endpoint as max_age."
            >
              <ul className="space-y-2.5">
                {state.decisions.map((d) => {
                  const attempted = attempts[d.action.id];
                  const shown = attempted ?? d;
                  return (
                    <li
                      key={d.action.id}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-zinc-100">
                              {d.action.label}
                            </span>
                            <span
                              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${TIER_STYLES[d.action.tier]}`}
                            >
                              {d.action.tier}
                            </span>
                            {d.action.maxAgeSeconds != null ? (
                              <span className="font-mono text-[10px] text-zinc-500">
                                max_age={d.action.maxAgeSeconds}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                            {d.action.blurb}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Pill tone={d.allowed ? "good" : "bad"}>
                            {d.allowed ? "allow" : "deny"}
                          </Pill>
                          <button
                            onClick={() => attempt(d.action.id)}
                            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-50"
                          >
                            Attempt
                          </button>
                        </div>
                      </div>

                      {attempted ? (
                        <div className="mt-3 border-t border-zinc-800 pt-3">
                          <CheckTrace checks={shown.checks} />
                          {shown.stepUp ? (
                            <div
                              className={`mt-2.5 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 ${
                                shown.stepUp.kind === "manual_review"
                                  ? "border-rose-500/30 bg-rose-500/5"
                                  : "border-amber-500/25 bg-amber-500/5"
                              }`}
                            >
                              <span
                                className={`min-w-0 flex-1 text-xs leading-relaxed ${
                                  shown.stepUp.kind === "manual_review"
                                    ? "text-rose-200/90"
                                    : "text-amber-200/90"
                                }`}
                              >
                                {shown.stepUp.message}
                              </span>
                              {shown.stepUp.kind !== "manual_review" ? (
                                <button
                                  disabled={busy}
                                  onClick={() => runCheck(d.action.id)}
                                  className="shrink-0 rounded-md bg-amber-400 px-2.5 py-1 text-xs font-medium text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40"
                                >
                                  Step up →
                                </button>
                              ) : (
                                <Pill tone="bad">manual review</Pill>
                              )}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel title="Event log" hint="The audit trail a real RP would keep.">
              {state.events.length === 0 ? (
                <p className="text-xs text-zinc-600">
                  Nothing yet. Run a Selfie Check to establish an anchor.
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {state.events.map((e, i) => (
                    <li
                      key={`${e.at}-${i}`}
                      className="flex gap-3 border-b border-zinc-800/60 pb-1.5 text-xs last:border-0"
                    >
                      <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-600">
                        {relativeTime(e.at, now)}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={
                            e.kind.includes("broken") ||
                            e.kind.includes("denied") ||
                            e.kind.includes("failed")
                              ? "text-rose-300"
                              : e.kind.includes("allowed") ||
                                  e.kind.includes("confirmed") ||
                                  e.kind.includes("anchor_created")
                                ? "text-emerald-300"
                                : "text-zinc-400"
                          }
                        >
                          {e.summary}
                        </span>
                        {e.detail ? (
                          <span className="block font-mono text-[10px] text-zinc-600">
                            {e.detail}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>

          {/* ----------------------------------------------- right column */}
          <div className="space-y-4">
            {state.mode === "live" ? (
              <Panel
                title="Live preflight"
                hint="Selfie Check has four gates and only one is self-service. This names the blocker instead of letting it surface as a cryptic code later."
                right={
                  <button
                    disabled={preBusy}
                    onClick={runPreflight}
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-50 disabled:opacity-40"
                  >
                    {preBusy ? "probing…" : pre ? "re-run" : "Run preflight"}
                  </button>
                }
              >
                {!pre ? (
                  <p className="text-xs leading-relaxed text-zinc-600">
                    Probes your app_id, action and RP registration against the
                    Developer Portal using a deliberately invalid proof — the
                    error code reveals which gate is closed.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {pre.map((c) => (
                      <li key={c.id} className="flex gap-2.5">
                        <span
                          className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-zinc-950 ${
                            c.status === "ok"
                              ? "bg-emerald-400"
                              : c.status === "blocked"
                                ? "bg-rose-400"
                                : "bg-zinc-600"
                          }`}
                        >
                          {c.status === "ok" ? "✓" : c.status === "blocked" ? "✕" : "?"}
                        </span>
                        <span className="min-w-0 text-xs leading-relaxed">
                          <span
                            className={
                              c.status === "ok"
                                ? "font-medium text-emerald-300"
                                : c.status === "blocked"
                                  ? "font-medium text-rose-300"
                                  : "font-medium text-zinc-400"
                            }
                          >
                            {c.label}
                          </span>
                          {c.code ? (
                            <span className="ml-1.5 font-mono text-[10px] text-zinc-600">
                              {c.code}
                            </span>
                          ) : null}
                          <span className="block text-zinc-500">{c.detail}</span>
                          {c.fix ? (
                            <span className="mt-1 block rounded border border-amber-500/25 bg-amber-500/5 px-2 py-1 text-amber-200/85">
                              {c.fix}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ) : null}

            <Panel
              title="Run a Selfie Check"
              hint={
                liveActive
                  ? "Opens the real IDKit widget against your app_id."
                  : "Pick a sandbox state or error code, then run it."
              }
              right={
                state.mode === "live" ? (
                  <button
                    onClick={() => setSimulate((v) => !v)}
                    className={`rounded-md border px-2 py-0.5 font-mono text-[10px] transition ${
                      simulate
                        ? "border-sky-500/50 bg-sky-500/10 text-sky-300"
                        : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {simulate ? "simulating" : "simulate"}
                  </button>
                ) : null
              }
            >
              {liveActive ? (
                <p className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs leading-relaxed text-zinc-400">
                  Signs a fresh <code className="font-mono">rp_context</code>{" "}
                  server-side, then hands off to World App — deep link on mobile,
                  QR on desktop. If Selfie Check isn&apos;t flagged on your app
                  yet you&apos;ll get{" "}
                  <code className="font-mono text-rose-300">
                    feature_unavailable
                  </code>
                  ; hit <span className="text-sky-300">simulate</span> to keep
                  testing the policy.
                </p>
              ) : scenario ? (
                <p className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs leading-relaxed text-zinc-400">
                  {scenario.blurb}
                </p>
              ) : null}

              <button
                disabled={busy}
                onClick={() => runCheck()}
                className="w-full rounded-lg bg-zinc-100 px-3 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:opacity-40"
              >
                {busy ? "Running…" : "Run Selfie Check"}
              </button>

              {stage ? (
                <ol className="mt-3 space-y-1">
                  {stageList.map((s) => {
                    const idx = stageList.indexOf(s);
                    const cur = stageList.indexOf(stage);
                    return (
                      <li
                        key={s}
                        className={`flex items-center gap-2 text-xs ${idx < cur ? "text-zinc-600" : idx === cur ? "text-zinc-100" : "text-zinc-700"}`}
                      >
                        <span
                          className={`size-1.5 rounded-full ${idx < cur ? "bg-zinc-600" : idx === cur ? "animate-pulse bg-sky-400" : "bg-zinc-800"}`}
                        />
                        {s}
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              <div
                className={`mt-4 space-y-3 ${liveActive ? "pointer-events-none opacity-35" : ""}`}
              >
                {grouped.map(([group, list]) => (
                  <div key={group}>
                    <p className="mb-1.5 font-mono text-[10px] tracking-wide text-zinc-600 uppercase">
                      {GROUP_LABELS[group]}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setScenarioId(s.id)}
                          className={`rounded-md border px-2 py-1 font-mono text-[10px] transition ${
                            s.id === scenarioId
                              ? "border-zinc-400 bg-zinc-100 text-zinc-950"
                              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Proof inspector"
              hint="What World App returned and what gets forwarded to the verify endpoint."
              right={
                proof?.ok ? (
                  <button
                    onClick={() => setShowRaw((v) => !v)}
                    className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
                  >
                    {showRaw ? "hide body" : "show body"}
                  </button>
                ) : null
              }
            >
              {!proof ? (
                <p className="text-xs text-zinc-600">No proof this session.</p>
              ) : !proof.ok ? (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <Pill tone="bad">{proof.errorCode}</Pill>
                    <span className="font-mono text-[10px] text-zinc-600">
                      IDKitErrorCode
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-zinc-400">
                    {proof.detail}
                  </p>
                </div>
              ) : (
                <div>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Pill
                      tone={
                        proof.continuityEvent === "continuity_broken"
                          ? "bad"
                          : "good"
                      }
                    >
                      {proof.continuityEvent.replaceAll("_", " ")}
                    </Pill>
                    <Pill>{proof.credential.protocol_version}</Pill>
                    <Pill>{proof.credential.environment}</Pill>
                  </div>
                  <dl>
                    <Field
                      label="identifier"
                      value={proof.credential.identifier}
                    />
                    <Field
                      label="nullifier"
                      value={proof.credential.nullifierShort}
                    />
                    <Field
                      label="merkle_root"
                      value={`${proof.credential.merkle_root.slice(0, 12)}…`}
                      tone="muted"
                    />
                    <Field
                      label="signal_hash"
                      value={
                        proof.credential.signal_hash
                          ? `${proof.credential.signal_hash.slice(0, 12)}…`
                          : "—"
                      }
                      tone="muted"
                    />
                    <Field
                      label="proof"
                      value={proof.credential.proofPreview}
                      tone="muted"
                    />
                  </dl>
                  {showRaw ? (
                    <div className="mt-3">
                      <p className="mb-1.5 font-mono text-[10px] text-zinc-600">
                        POST /api/v2/verify/{"{app_id}"}
                      </p>
                      <Json value={proof.verify.request} />
                      {proof.verify.note ? (
                        <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                          {proof.verify.note}
                        </p>
                      ) : null}
                      {proof.verify.response ? (
                        <>
                          <p className="mt-3 mb-1.5 font-mono text-[10px] text-zinc-600">
                            response · {proof.verify.status}
                          </p>
                          <Json value={proof.verify.response} />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </Panel>

            <Panel
              title="Why continuity, not personhood"
              hint="The integration detail that decides whether any of this works."
            >
              <p className="text-xs leading-relaxed text-zinc-400">
                Nullifiers are scoped to{" "}
                <code className="font-mono text-zinc-300">
                  (credential, app_id, action)
                </code>
                . Continuity only works if the{" "}
                <code className="font-mono text-zinc-300">action</code> stays
                fixed across sessions. Rotating it per request — the natural
                instinct if you read it as a nonce — silently breaks continuity:
                every returning user looks brand new, and nothing errors. The
                per-request nonce belongs in{" "}
                <code className="font-mono text-zinc-300">rp_context</code>,
                which is signed server-side and expires in 300s.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
