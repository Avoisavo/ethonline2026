"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

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
      source: "live";
      continuityEvent:
        | "anchor_created"
        | "continuity_confirmed"
        | "continuity_broken";
      credential: {
        identifier: string;
        nullifier: string;
        nullifierShort: string;
        merkle_root: string | null;
        issuer_schema_id: number | null;
        expires_at_min: number | null;
        signal_hash: string | null;
        proofPreview: string;
        protocol_version: string;
        environment: string;
      };
      verify: {
        status: number | null;
        target: string;
        url: string;
        request: Record<string, unknown>;
        response: unknown;
        environmentNote?: string | null;
      };
      account: {
        continuity: string;
        continuityBreaks: number;
        anchorShort: string;
        lastShort: string;
      };
      agent:
        | { status: "exhausted"; roster: { taken: number; total: number } }
        | {
            status: "assigned" | "returning";
            id: string;
            callsign: string;
            role: string;
            claimedAt: number;
            reclaims: number;
            sessions: number;
            roster: { taken: number; total: number };
          };
      decision: Decision | null;
    }
  | { ok: false; errorCode: string; detail: string };

/**
 * Remediation for the World App error codes this flow can surface.
 *
 * Kept here because World's published error-code reference does not list every
 * code the shipped SDK enum can emit — `feature_unavailable` among them — so
 * there is nothing to search for when one arrives. Each entry says what to do,
 * not just what happened.
 */
const WORLD_APP_ERRORS: Record<string, string> = {
  feature_unavailable:
    "Selfie Check is not enabled for this app_id. It is an access-gated beta — request the flag for your app. Nothing local can work around this.",
  world_id_4_not_available:
    "World App on this device predates World ID 4.0. Update World App. Falling back to a 3.0 proof is deliberately not offered: the 3.0 nullifier is a different, unlinkable value, so one human would end up with two anchors.",
  credential_unavailable:
    "This World App has never enrolled Selfie Check. The user completes enrollment inside World App first.",
  verification_rejected:
    "Liveness or face match failed inside World App. The user can retry; repeated failures are the credential working as intended.",
  user_rejected: "The user dismissed the World App sheet.",
  invalid_rp_signature:
    "The rp_context signature was rejected. Usually the signing key does not match the portal's signer address, or SHA3-256 was used where Keccak-256 is required.",
  rp_signature_expired:
    "The rp_context outlived its 300s TTL. Mint a fresh one per attempt rather than caching it.",
  duplicate_nonce:
    "This rp_context nonce was already spent. Each attempt needs its own context.",
  inclusion_proof_pending:
    "The credential is still being included. Retryable — wait and run again.",
  connection_failed:
    "The bridge connection dropped before a proof came back. Retryable.",
  max_verifications_reached:
    "The action's verification cap is exhausted. A continuity gate needs unlimited re-verification, so the cap should not be set on this action.",
};

/** IDKit pulls in WASM, so keep it out of the server bundle and first paint. */
const LiveSelfieCheck = dynamic(() => import("./live-widget"), { ssr: false });

type LiveContext = {
  app_id: `app_${string}`;
  action: string;
  rp_context: RpContext;
  signal: string;
  environment: "production" | "staging" | "sandbox";
  proof_version: "3.0" | "4.0";
};

/* ------------------------------------------------------------------ console */

export default function FaceConsole({
  initialState,
}: {
  initialState: ConsoleState;
}) {
  const [state, setState] = useState<ConsoleState>(initialState);
  const [proof, setProof] = useState<VerifyResponse | null>(null);
  const [attempts, setAttempts] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [showRaw, setShowRaw] = useState(false);
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

  /**
   * Mint a fresh rp_context, then open the real IDKit widget.
   *
   * A context is minted per attempt rather than cached: it carries a nonce the
   * server records as spent, and it expires in 300s, so reusing one surfaces as
   * `duplicate_nonce` or `rp_signature_expired`.
   */
  const runCheck = useCallback(
    async (intent?: string) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      pendingIntent.current = intent;
      setProof(null);
      try {
        const res = await fetch("/api/selfie-check/context", {
          method: "POST",
        });
        const ctx = (await res.json()) as
          | ({ ok: true } & LiveContext)
          | { ok: false; error: string; problems: { name: string }[] };
        if (!ctx.ok) {
          setProof({
            ok: false,
            errorCode: ctx.error,
            detail: `Not configured: ${ctx.problems.map((p) => p.name).join(", ")}. See the preflight panel.`,
          });
          return;
        }
        setLiveCtx(ctx);
        setLiveOpen(true);
      } finally {
        setBusy(false);
        running.current = false;
      }
    },
    [],
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      {liveCtx ? (
        <LiveSelfieCheck
          appId={liveCtx.app_id}
          action={liveCtx.action}
          rpContext={liveCtx.rp_context}
          signal={liveCtx.signal}
          environment={liveCtx.environment}
          proofVersion={liveCtx.proof_version}
          open={liveOpen}
          onOpenChange={setLiveOpen}
          onResult={(result: IDKitResult) =>
            void submit({ result, intent: pendingIntent.current })
          }
          onFailure={(code: string) => {
            // Also log it: the widget renders its own "Something went wrong"
            // screen over the page, so the code below can be missed entirely
            // until the sheet is dismissed.
            console.error("[selfie-check] IDKit error:", code);
            setProof({
              ok: false,
              errorCode: code,
              detail:
                WORLD_APP_ERRORS[code] ??
                "World App returned this error code. It is not in the mapped set — check the browser console and World's error-code reference.",
            });
            setLiveOpen(false);
          }}
        />
      ) : null}
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* ------------------------------------------------------- header */}
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
              Continuity Gate
            </h1>
            <Pill tone={state.configured ? "good" : "bad"}>
              {state.configured ? "live" : "not configured"}
            </Pill>
            {state.environment ? <Pill>{state.environment}</Pill> : null}
            {/* Only shown once a proof has actually been verified by the
                portal, so the badge never claims more than has happened. */}
            {proof?.ok && proof.verify.status === 200 ? (
              <Pill tone="good">proof verified · HTTP 200</Pill>
            ) : null}
            <Pill>
              {state.proofVersion === "4.0"
                ? "selfie · schema 11"
                : "selfie · protocol 3.0"}
            </Pill>
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
          {!state.configured ? (
            <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs leading-relaxed text-rose-200/85">
              <p className="font-medium">
                Not configured — every proof here is real, so there is nothing
                to fall back to.
              </p>
              <ul className="mt-1.5 space-y-1">
                {state.problems.map((p) => (
                  <li key={p.name}>
                    <code className="font-mono text-rose-200">{p.name}</code> —{" "}
                    {p.issue} <span className="text-rose-200/60">{p.fix}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.environmentNote ? (
            <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-200/85">
              {state.environmentNote}
            </p>
          ) : null}
        </header>

        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          {/* ------------------------------------------------ left column */}
          <div className="space-y-4">
            <Panel
              title="Your agent"
              hint="One human, one agent. The claim is bound to your nullifier, so it survives clearing cookies and cannot be re-rolled."
              right={
                <span className="font-mono text-[10px] text-zinc-600">
                  {state.roster.taken}/{state.roster.total} claimed
                </span>
              }
            >
              {state.agent ? (
                <div>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight text-zinc-50">
                      {state.agent.callsign}
                    </span>
                    <Pill tone="good">{state.agent.id}</Pill>
                    <Pill>{state.agent.role}</Pill>
                  </div>
                  <dl className="mt-3">
                    <Field
                      label="bound to nullifier"
                      value={state.agent.nullifierShort}
                    />
                    <Field
                      label="claimed"
                      value={relativeTime(state.agent.claimedAt, now)}
                    />
                    <Field
                      label="re-verified"
                      value={`${state.agent.reclaims}× across ${state.agent.sessions} browser session(s)`}
                    />
                  </dl>
                  <p className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs leading-relaxed text-emerald-200/85">
                    This is the only agent you can ever be issued. Re-running a
                    Selfie Check hands back{" "}
                    <span className="font-medium">{state.agent.callsign}</span>,
                    not a new agent — the nullifier is the same, so the registry
                    recognizes you rather than allocating again.
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-zinc-400">
                    No agent yet. Pass a Selfie Check and one is assigned to you
                    permanently.
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-zinc-600">
                    Assignment is keyed on the proof&apos;s nullifier, not on a
                    cookie. Clearing site data, using a private window, or
                    resetting this demo will not get you a second agent —
                    it hands back the same one.
                  </p>
                </div>
              )}
            </Panel>

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

            <Panel
              title="Run a Selfie Check"
              hint="Opens the real IDKit widget against your app_id. There is no simulator."
            >
              <p className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs leading-relaxed text-zinc-400">
                Signs a fresh <code className="font-mono">rp_context</code>{" "}
                server-side, then hands off to World App — deep link on mobile,
                QR on desktop. Requests a World ID{" "}
                <span className="text-zinc-200">{state.proofVersion}</span>{" "}
                proof via{" "}
                <code className="font-mono">
                  {state.proofVersion === "4.0"
                    ? 'CredentialRequest("selfie")'
                    : "selfieCheckLegacy()"}
                </code>
                , and the server accepts only that version, so one human cannot
                end up with two unlinkable anchors.
              </p>

              <button
                disabled={busy || !state.configured}
                onClick={() => runCheck()}
                className="w-full rounded-lg bg-zinc-100 px-3 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:opacity-40"
              >
                {busy
                  ? "Opening World App…"
                  : state.configured
                    ? "Run Selfie Check"
                    : "Configure credentials first"}
              </button>

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
                      value={
                        proof.credential.merkle_root
                          ? `${proof.credential.merkle_root.slice(0, 12)}…`
                          : "— (4.0: proof[4])"
                      }
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
                    {proof.credential.issuer_schema_id != null ? (
                      <Field
                        label="issuer_schema_id"
                        value={`${proof.credential.issuer_schema_id} (11 = selfie)`}
                      />
                    ) : null}
                    <Field
                      label="proof"
                      value={proof.credential.proofPreview}
                      tone="muted"
                    />
                  </dl>
                  {showRaw ? (
                    <div className="mt-3">
                      <p className="mb-1.5 font-mono text-[10px] text-zinc-600">
                        POST /api/v4/verify/{"{rp_id}"} · protocol{" "}
                        {proof.credential.protocol_version}
                      </p>
                      <Json value={proof.verify.request} />
                      {proof.verify.environmentNote ? (
                        <p className="mt-1.5 text-[10px] leading-relaxed text-amber-200/70">
                          {proof.verify.environmentNote}
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
