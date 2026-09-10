import { NextResponse } from "next/server";

import { evaluate, findAction } from "@/lib/selfie-check/policy";
import { accountCookie, resolveAccountId } from "@/lib/selfie-check/session";
import {
  getAccount,
  pushEvent,
  saveAccount,
  toSnapshot,
} from "@/lib/selfie-check/store";

/**
 * Attempt a gated action.
 *
 * The Selfie Check signal is never consulted as a bare boolean — the policy
 * engine returns the full check trace, and the failing check determines whether
 * the answer is "step up with a fresh selfie" or "a selfie can't fix this".
 */
export async function POST(request: Request) {
  const { id, isNew } = await resolveAccountId();
  const record = getAccount(id);
  const { actionId } = (await request.json().catch(() => ({}))) as {
    actionId?: string;
  };

  const action = actionId ? findAction(actionId) : undefined;
  if (!action) {
    return NextResponse.json(
      { ok: false, error: `Unknown action "${actionId}".` },
      { status: 400 },
    );
  }

  const decision = evaluate(action, toSnapshot(record), Date.now());
  const blocking = decision.checks.find((c) => c.status === "fail");

  pushEvent(record, {
    at: Date.now(),
    kind: decision.allowed ? "action_allowed" : "action_denied",
    summary: decision.allowed
      ? `Allowed: ${action.label}`
      : `Denied: ${action.label} — ${blocking?.label ?? "policy"}`,
    detail: blocking?.detail ?? decision.stepUp?.message,
  });
  saveAccount(record);

  const res = NextResponse.json({ ok: true, decision });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}
