"use client";

import type { CheckStatus, DecisionCheck, Tier } from "@/lib/selfie-check/policy";

const STATUS_STYLES: Record<CheckStatus, { dot: string; text: string; glyph: string }> = {
  pass: { dot: "bg-emerald-400", text: "text-emerald-300", glyph: "✓" },
  fail: { dot: "bg-rose-400", text: "text-rose-300", glyph: "✕" },
  warn: { dot: "bg-amber-400", text: "text-amber-300", glyph: "!" },
  skip: { dot: "bg-zinc-600", text: "text-zinc-500", glyph: "–" },
};

export const TIER_STYLES: Record<Tier, string> = {
  open: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
  sensitive: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

export function Panel({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-wide text-zinc-200 uppercase">
            {title}
          </h2>
          {hint ? (
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{hint}</p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  value,
  mono = true,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: "default" | "muted" | "good" | "bad" | "warn";
}) {
  const tones = {
    default: "text-zinc-200",
    muted: "text-zinc-500",
    good: "text-emerald-300",
    bad: "text-rose-300",
    warn: "text-amber-300",
  };
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-zinc-800/60 py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-zinc-500">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-xs ${mono ? "font-mono" : ""} ${tones[tone]}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function CheckTrace({ checks }: { checks: DecisionCheck[] }) {
  return (
    <ol className="space-y-1.5">
      {checks.map((c) => {
        const s = STATUS_STYLES[c.status];
        return (
          <li key={c.id} className="flex gap-2.5">
            <span
              className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-zinc-950 ${s.dot}`}
            >
              {s.glyph}
            </span>
            <span className="min-w-0 text-xs leading-relaxed">
              <span className={`font-medium ${s.text}`}>{c.label}</span>
              <span className="text-zinc-500"> — {c.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-zinc-400">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn" | "info";
}) {
  const tones = {
    neutral: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
    good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    bad: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function relativeTime(ms: number | null, now: number): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return "never verified";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
