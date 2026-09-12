import { NextResponse } from "next/server";

import { getConfig } from "@/lib/selfie-check/config";
import { findScenario, runMockScenario } from "@/lib/selfie-check/mock";
import {
  credentialExpiresAt,
  evaluate,
  findAction,
  proofAgeSeconds,
} from "@/lib/selfie-check/policy";
import { accountCookie, resolveAccountId } from "@/lib/selfie-check/session";
import {
  type AccountRecord,
  getAccount,
  pushEvent,
  saveAccount,
  sha256Hex,
  shortNullifier,
  toSnapshot,
} from "@/lib/selfie-check/store";
import {
  SELFIE_IDENTIFIER,
  isSelfieIdentifier,
  type IDKitResultV3,
  type ResponseItemV3,
} from "@/lib/selfie-check/types";
import { clampMaxAge, verifySelfieProof } from "@/lib/selfie-check/verify";

type Body = {
  /** Which gated action the user is trying to reach. */
  intent?: string;
  /** Mock mode: which sandbox scenario to run. */
  scenarioId?: string;
  /** Live mode: the raw IDKit result forwarded from the widget. */
  result?: IDKitResultV3;
};

export async function POST(request: Request) {
  const config = getConfig();
  const { id, isNew } = await resolveAccountId();
  const record = getAccount(id);
  const body = (await request.json().catch(() => ({}))) as Body;

  const intent = body.intent ? findAction(body.intent) : undefined;
  const maxAge = clampMaxAge(intent?.maxAgeSeconds ?? null);

  // The signal binds the proof to this account, so a proof minted for one
  // account can't be replayed against another. World App hashes the signal with
  // `hash_to_field`, so re-derive it the same way rather than with a plain
  // digest — `sha256(id)` would never match a real proof.
  const { hashSignal } = await import("@worldcoin/idkit/hashing");
  const signalHash = hashSignal(id);

  let item: ResponseItemV3;
  let mintedAt = Date.now();
  let credentialIssuedAt = record.credentialIssuedAt ?? Date.now();
  let source: "mock" | "live";
  let scenarioId: string | null = null;
  let personaLabel: string | null = null;
  let userState: string | null = null;
  let rawResult: IDKitResultV3;

  if (body.result) {
    // ---- Live path: World App produced a real World ID 3.0 proof. ----
    source = "live";
    rawResult = body.result;
    // selfieCheckLegacy() only ever returns World ID 3.0. A 4.0 result would
    // carry `proof` as string[] and not survive the legacy verify endpoint.
    if (rawResult.protocol_version !== "3.0") {
      return fail(
        record,
        id,
        isNew,
        "unexpected_response",
        `Expected a World ID 3.0 result from Selfie Check, got ${String(rawResult.protocol_version)}.`,
      );
    }
    const found = rawResult.responses?.find((r) =>
      isSelfieIdentifier(r.identifier),
    );
    if (!found) {
      return fail(
        record,
        id,
        isNew,
        "unexpected_response",
        `Result carried no "${SELFIE_IDENTIFIER}" credential response.`,
      );
    }
    // Reject a proof that was minted for a different account.
    if (found.signal_hash && found.signal_hash !== signalHash) {
      return fail(
        record,
        id,
        isNew,
        "invalid_signal",
        "Proof signal_hash does not bind to this account — refusing a cross-account replay.",
      );
    }
    item = found;
  } else {
    // ---- Mock path: local proof engine stands in for World App. ----
    source = "mock";
    const scenario = findScenario(body.scenarioId ?? "hot_same_human");
    if (!scenario) {
      return NextResponse.json(
        { ok: false, error: `Unknown scenario "${body.scenarioId}".` },
        { status: 400 },
      );
    }
    scenarioId = scenario.id;

    const outcome = runMockScenario({
      scenario,
      appId: config.mode === "live" ? config.appId : "app_mock",
      action: config.action,
      nonce: `0x${sha256Hex(`${id}:${Date.now()}`)}`,
      signalHash,
    });

    if (!outcome.ok) {
      return fail(
        record,
        id,
        isNew,
        outcome.errorCode,
        scenario.blurb,
        scenario.id,
      );
    }

    item = outcome.result.responses[0];
    rawResult = outcome.result;
    mintedAt = outcome.meta.mintedAt;
    credentialIssuedAt = outcome.meta.credentialIssuedAt;
    personaLabel = outcome.meta.personaLabel;
    userState = outcome.meta.userState;
  }

  // ---- Replay guard. In production this is a UNIQUE (nullifier, action)
  // ---- constraint; the nonce check is what stops a captured rp_context from
  // ---- being reused.
  if (rawResult.nonce && record.usedNonces.includes(rawResult.nonce)) {
    return fail(
      record,
      id,
      isNew,
      "duplicate_nonce",
      "This rp_context nonce was already spent.",
      scenarioId ?? undefined,
    );
  }

  // ---- Server-side verification against the Developer Portal (live only).
  let verifyAttempt: Awaited<ReturnType<typeof verifySelfieProof>> | null = null;
  if (config.mode === "live" && source === "live") {
    verifyAttempt = await verifySelfieProof({
      config,
      item,
      action: config.action,
      // v4 requires the rp_context nonce the proof was minted against.
      nonce: rawResult.nonce,
      maxAgeSeconds: maxAge,
    });
    if (!verifyAttempt.ok) {
      return fail(
        record,
        id,
        isNew,
        verifyAttempt.code ?? "unexpected_response",
        verifyAttempt.guidance ??
          "Verify endpoint rejected the proof.",
        scenarioId ?? undefined,
        verifyAttempt,
      );
    }
  }

  // ---- Proof accepted. Update the anchor / continuity state.
  const nullifier = item.nullifier;
  const previousAnchor = record.anchorNullifier;
  let continuityEvent:
    | "anchor_created"
    | "continuity_confirmed"
    | "continuity_broken";

  if (previousAnchor == null) {
    record.anchorNullifier = nullifier;
    record.anchoredAt = mintedAt;
    continuityEvent = "anchor_created";
  } else if (nullifier === previousAnchor) {
    continuityEvent = "continuity_confirmed";
  } else {
    continuityEvent = "continuity_broken";
    record.continuityBreaks += 1;
  }

  record.lastNullifier = nullifier;
  record.lastVerifiedAt = mintedAt;
  record.credentialIssuedAt = credentialIssuedAt;
  if (!record.seenNullifiers.includes(nullifier)) {
    record.seenNullifiers.push(nullifier);
  }
  if (rawResult.nonce) record.usedNonces.push(rawResult.nonce);

  const summaries: Record<typeof continuityEvent, string> = {
    anchor_created: `Human anchor established — ${shortNullifier(nullifier)}`,
    continuity_confirmed: `Continuity confirmed — same nullifier as anchor`,
    continuity_broken: `Continuity BREAK — ${shortNullifier(nullifier)} ≠ anchor ${shortNullifier(previousAnchor)}`,
  };

  pushEvent(record, {
    at: Date.now(),
    kind: continuityEvent,
    summary: summaries[continuityEvent],
    detail: [
      personaLabel && `face: ${personaLabel}`,
      userState && `state: ${userState}`,
      scenarioId && `scenario: ${scenarioId}`,
    ]
      .filter(Boolean)
      .join(" · "),
  });
  saveAccount(record);

  const snapshot = toSnapshot(record);
  const now = Date.now();

  const res = NextResponse.json({
    ok: true,
    source,
    scenarioId,
    continuityEvent,
    credential: {
      identifier: item.identifier,
      nullifier,
      nullifierShort: shortNullifier(nullifier),
      merkle_root: item.merkle_root,
      signal_hash: item.signal_hash ?? null,
      proofPreview: `${item.proof.slice(0, 34)}… (${item.proof.length - 2} hex chars)`,
      protocol_version: rawResult.protocol_version,
      environment: rawResult.environment,
    },
    verify: verifyAttempt
      ? {
          status: verifyAttempt.status,
          target: verifyAttempt.target,
          url: verifyAttempt.url,
          request: verifyAttempt.request,
          response: verifyAttempt.response,
        }
      : {
          status: null,
          target: "v4" as const,
          url: "https://developer.world.org/api/v4/verify/{rp_id}",
          request: {
            protocol_version: "3.0",
            nonce: rawResult.nonce,
            action: config.action,
            responses: [
              {
                identifier: item.identifier,
                merkle_root: item.merkle_root,
                nullifier: item.nullifier,
                signal_hash: item.signal_hash,
                proof: `${item.proof.slice(0, 18)}… (truncated)`,
              },
            ],
          },
          response: null,
          note: "Mock mode — this is the body that would be POSTed to /api/v4/verify/{rp_id}.",
        },
    account: {
      continuity: snapshot.continuity,
      continuityBreaks: record.continuityBreaks,
      anchorShort: shortNullifier(snapshot.anchorNullifier),
      lastShort: shortNullifier(snapshot.lastNullifier),
      proofAgeSeconds: proofAgeSeconds(snapshot, now),
      credentialExpiresAt: credentialExpiresAt(snapshot),
    },
    decision: intent ? evaluate(intent, snapshot, now) : null,
  });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}

/** Record a failed verification and return it in the shape the UI expects. */
function fail(
  record: AccountRecord,
  id: string,
  isNew: boolean,
  code: string,
  detail: string,
  scenarioId?: string,
  verifyAttempt?: Awaited<ReturnType<typeof verifySelfieProof>>,
) {
  pushEvent(record, {
    at: Date.now(),
    kind: "verification_failed",
    summary: `Verification failed — ${code}`,
    detail,
  });
  saveAccount(record);

  const res = NextResponse.json({
    ok: false,
    errorCode: code,
    detail,
    scenarioId: scenarioId ?? null,
    verify: verifyAttempt
      ? {
          status: verifyAttempt.status,
          request: verifyAttempt.request,
          response: verifyAttempt.response,
        }
      : null,
  });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}
