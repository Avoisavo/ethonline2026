import { NextResponse } from "next/server";
import { hashSignal } from "@worldcoin/idkit/hashing";

import {
  ConfigError,
  environmentAsymmetry,
  requireConfig,
} from "@/lib/selfie-check/config";
import {
  credentialExpiresAt,
  evaluate,
  findAction,
  proofAgeSeconds,
} from "@/lib/selfie-check/policy";
import { accountCookie, resolveAccountId } from "@/lib/selfie-check/session";
import {
  type AccountRecord,
  claimAgent,
  getAccount,
  pushEvent,
  rosterStatus,
  saveAccount,
  shortNullifier,
  toSnapshot,
} from "@/lib/selfie-check/store";
import {
  SCHEMA_IDS,
  SELFIE_IDENTIFIER,
  isSelfieIdentifier,
  normalizeV3,
  normalizeV4,
  type AnyIDKitResult,
  type NormalizedCredential,
  type ResponseItemV3,
  type ResponseItemV4,
} from "@/lib/selfie-check/types";
import { clampMaxAge, verifySelfieProof } from "@/lib/selfie-check/verify";

type Body = {
  /** Which gated action the user is trying to reach. */
  intent?: string;
  /** The raw IDKit result forwarded from the widget. */
  result?: AnyIDKitResult;
};

export async function POST(request: Request) {
  let config;
  try {
    config = requireConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return NextResponse.json(
        { ok: false, errorCode: "not_configured", problems: error.problems },
        { status: 503 },
      );
    }
    throw error;
  }

  const { id, isNew } = await resolveAccountId();
  const record = getAccount(id);
  const body = (await request.json().catch(() => ({}))) as Body;

  const intent = body.intent ? findAction(body.intent) : undefined;
  const maxAge = clampMaxAge(intent?.maxAgeSeconds ?? null);

  if (!body.result) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "missing_result",
        detail:
          "No IDKit result in the request. A proof must come from World App — there is no local proof engine.",
      },
      { status: 400 },
    );
  }

  const rawResult = body.result;

  // ---- Gate 1: protocol version.
  //
  // The rp_context signature covers only
  // version || nonce || created_at || expires_at || hash_to_field(action).
  // `allow_legacy_proofs`, the preset and the constraint tree are UNSIGNED and
  // chosen by the client, so a caller holding a legitimately minted context can
  // re-run the request as `selfieCheckLegacy()` and return a genuine 3.0 proof
  // for the same action.
  //
  // That matters because the 3.0 and 4.0 nullifiers for one human are different
  // values, unlinkable by design. Accepting both for a single action would let
  // one human hold two anchors — enroll on 4.0, then present 3.0 and read as a
  // different human. Every decision downstream compares nullifiers, so
  // accepting both versions breaks the comparison it depends on.
  if (rawResult.protocol_version !== config.proofVersion) {
    return fail(
      record,
      id,
      isNew,
      "wrong_protocol_version",
      `This deployment accepts World ID ${config.proofVersion} only (WORLD_PROOF_VERSION), got ${String(
        (rawResult as { protocol_version?: unknown }).protocol_version,
      )}. The other version's nullifier is a different, unlinkable value, so accepting both would allow two identities per human.`,
    );
  }

  // ---- Gate 2: the credential itself.
  //
  // Also unsigned, so it is asserted here rather than assumed from what the
  // widget was configured to request.
  const found = rawResult.responses?.find((r) =>
    isSelfieIdentifier(r.identifier),
  );
  if (!found) {
    const seen = (rawResult.responses ?? [])
      .map((r) => r.identifier)
      .join(", ");
    return fail(
      record,
      id,
      isNew,
      "wrong_credential",
      `Result carried no "${SELFIE_IDENTIFIER}" credential${seen ? ` (got: ${seen})` : ""}.`,
    );
  }

  const item = found as ResponseItemV3 | ResponseItemV4;

  // ---- Gate 3: issuer_schema_id. 4.0 only — a 3.0 response has no numeric
  // field at all, which is itself worth stating: on 3.0 the identifier string
  // checked above is the ONLY thing identifying the credential.
  //
  // On 4.0 this check is load-bearing. The nullifier is deterministic over
  // (human, rp_id, action) and credential-independent, so the nullifier alone
  // cannot tell you which credential produced it. The schema id is the only
  // field that can: 11 for Selfie Check, 1 for proof_of_human. Without it a
  // proof_of_human or passport proof would satisfy a gate that is supposed to
  // mean "passed a Selfie Check".
  if (config.proofVersion === "4.0") {
    const schemaId = (item as ResponseItemV4).issuer_schema_id;
    if (schemaId !== SCHEMA_IDS.selfie) {
      return fail(
        record,
        id,
        isNew,
        "wrong_schema_id",
        `Expected issuer_schema_id ${SCHEMA_IDS.selfie} (selfie), got ${String(schemaId)}.`,
      );
    }
  }

  // ---- Gate 4: the signal binds the proof to this account.
  //
  // World App hashes the signal with hash_to_field, so re-derive it the same
  // way. sha256(id) would never match.
  const signalHash = hashSignal(id);
  if (!item.signal_hash) {
    return fail(
      record,
      id,
      isNew,
      "missing_signal",
      "Proof carried no signal_hash, so it cannot be bound to this account.",
    );
  }
  if (item.signal_hash !== signalHash) {
    return fail(
      record,
      id,
      isNew,
      "invalid_signal",
      "Proof signal_hash does not bind to this account — refusing a cross-account replay.",
    );
  }

  const cred: NormalizedCredential =
    config.proofVersion === "4.0"
      ? normalizeV4(item as ResponseItemV4)
      : normalizeV3(item as ResponseItemV3);

  // ---- Gate 5: nonce replay. In production this is a UNIQUE constraint; the
  // nonce check is what stops a captured rp_context from being reused.
  if (rawResult.nonce && record.usedNonces.includes(rawResult.nonce)) {
    return fail(
      record,
      id,
      isNew,
      "duplicate_nonce",
      "This rp_context nonce was already spent.",
    );
  }

  // ---- Gate 6: the Developer Portal verifies the proof. Nothing above this
  // line proves the proof is cryptographically valid.
  const verifyAttempt = await verifySelfieProof({
    config,
    item,
    protocolVersion: config.proofVersion,
    action: config.action,
    nonce: rawResult.nonce,
    maxAgeSeconds: maxAge,
  });
  if (!verifyAttempt.ok) {
    return fail(
      record,
      id,
      isNew,
      verifyAttempt.code ?? "verification_failed",
      verifyAttempt.guidance ?? "Verify endpoint rejected the proof.",
      verifyAttempt,
    );
  }

  // ---- Proof accepted. Update the anchor / continuity state.
  // When WE verified, which is what the freshness tiers measure.
  //
  // Do NOT use the portal's `created_at` for this. Measured on a real
  // re-verification: a fresh proof (new nonce, accepted, HTTP 200) came back
  // with the SAME `created_at` as a verification two hours earlier — so that
  // field tracks the credential/nullifier, not this verify call. Using it made
  // a just-completed check read as 2h old and denied the 1h-window tiers.
  // The proof's own age is enforced separately by `max_age` on the request.
  const verifiedAt = Date.now();
  const portalCreatedAt = portalTimestamp(verifyAttempt);
  const nullifier = item.nullifier;
  const previousAnchor = record.anchorNullifier;
  let continuityEvent:
    | "anchor_created"
    | "continuity_confirmed"
    | "continuity_broken";

  if (previousAnchor == null) {
    record.anchorNullifier = nullifier;
    record.anchoredAt = verifiedAt;
    continuityEvent = "anchor_created";
  } else if (nullifier === previousAnchor) {
    continuityEvent = "continuity_confirmed";
  } else {
    continuityEvent = "continuity_broken";
    record.continuityBreaks += 1;
  }

  record.lastNullifier = nullifier;
  record.lastVerifiedAt = verifiedAt;
  // The 90-day figure is an INACTIVITY window, not an absolute expiry: "After
  // 90 days without use, the user completes the camera flow again." So it
  // resets on every successful use rather than counting from first issuance.
  record.credentialIssuedAt = verifiedAt;
  if (!record.seenNullifiers.includes(nullifier)) {
    record.seenNullifiers.push(nullifier);
  }
  if (rawResult.nonce) record.usedNonces.push(rawResult.nonce);

  const summaries: Record<typeof continuityEvent, string> = {
    anchor_created: `Human anchor established — ${shortNullifier(nullifier)}`,
    continuity_confirmed: "Continuity confirmed — same nullifier as anchor",
    continuity_broken: `Continuity BREAK — ${shortNullifier(nullifier)} ≠ anchor ${shortNullifier(previousAnchor)}`,
  };

  pushEvent(record, {
    at: Date.now(),
    kind: continuityEvent,
    summary: summaries[continuityEvent],
    detail: `live proof · HTTP ${verifyAttempt.status} · ${verifyAttempt.target} · protocol ${config.proofVersion}${
      cred.issuerSchemaId != null ? ` · schema ${cred.issuerSchemaId}` : ""
    }`,
    source: "live",
    verifyStatus: verifyAttempt.status,
  });
  saveAccount(record);

  // ---- Assign the one agent this human is entitled to.
  //
  // Keyed on the nullifier, NOT the account cookie. Cookies are free to mint —
  // clearing site data or opening a private window produces a new account id —
  // so an account-keyed registry would hand out a fresh agent every time. The
  // nullifier is the same for this human on this action forever, which is the
  // only thing here that cannot be reset from the browser.
  //
  // Runs after saveAccount so a roster-exhausted claim still leaves the
  // continuity anchor recorded.
  const claim = claimAgent(config.action, nullifier, id);
  if (claim.status !== "exhausted") {
    pushEvent(record, {
      at: Date.now(),
      kind: claim.status === "assigned" ? "agent_assigned" : "agent_reclaimed",
      summary:
        claim.status === "assigned"
          ? `Agent assigned — ${claim.agent.callsign} (${claim.agent.id})`
          : `Same human, same agent — ${claim.agent.callsign}`,
      detail:
        claim.status === "assigned"
          ? `Bound to nullifier ${shortNullifier(nullifier)} for action "${config.action}". No further agent can be issued to this human.`
          : `Reclaim #${claim.claim.reclaims} from ${claim.claim.accountIds.length} browser session(s).`,
      source: "live",
      verifyStatus: verifyAttempt.status,
    });
  } else {
    pushEvent(record, {
      at: Date.now(),
      kind: "agent_unavailable",
      summary: "No agent available",
      detail: `All ${claim.total} agents in the roster are claimed by other humans.`,
      source: "live",
      verifyStatus: verifyAttempt.status,
    });
  }
  saveAccount(record);

  const snapshot = toSnapshot(record);
  const now = Date.now();

  const res = NextResponse.json({
    ok: true,
    source: "live" as const,
    continuityEvent,
    credential: {
      identifier: cred.identifier,
      nullifier,
      nullifierShort: shortNullifier(nullifier),
      merkle_root: cred.merkleRoot,
      signal_hash: cred.signalHash,
      issuer_schema_id: cred.issuerSchemaId,
      expires_at_min: cred.expiresAtMin,
      proofPreview: cred.proofPreview,
      protocol_version: rawResult.protocol_version,
      environment: rawResult.environment,
    },
    verify: {
      status: verifyAttempt.status,
      portalCreatedAt,
      target: verifyAttempt.target,
      url: verifyAttempt.url,
      request: verifyAttempt.request,
      response: verifyAttempt.response,
      environmentNote: environmentAsymmetry(config),
    },
    account: {
      continuity: snapshot.continuity,
      continuityBreaks: record.continuityBreaks,
      anchorShort: shortNullifier(snapshot.anchorNullifier),
      lastShort: shortNullifier(snapshot.lastNullifier),
      proofAgeSeconds: proofAgeSeconds(snapshot, now),
      credentialExpiresAt: credentialExpiresAt(snapshot),
    },
    agent:
      claim.status === "exhausted"
        ? {
            status: "exhausted" as const,
            roster: rosterStatus(),
          }
        : {
            status: claim.status,
            id: claim.agent.id,
            callsign: claim.agent.callsign,
            role: claim.agent.role,
            claimedAt: claim.claim.claimedAt,
            reclaims: claim.claim.reclaims,
            sessions: claim.claim.accountIds.length,
            roster: rosterStatus(),
          },
    decision: intent ? evaluate(intent, snapshot, now) : null,
  });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}

/**
 * Prefer the portal's own `created_at` over local time. It is the only
 * timestamp neither this server nor the client can influence, and proof
 * freshness decisions are made against it.
 */
function portalTimestamp(attempt: {
  response: unknown;
}): number | null {
  const created = (attempt.response as { created_at?: unknown })?.created_at;
  if (typeof created !== "string") return null;
  const ms = Date.parse(created);
  return Number.isFinite(ms) ? ms : null;
}

/** Record a failed verification and return it in the shape the UI expects. */
function fail(
  record: AccountRecord,
  id: string,
  isNew: boolean,
  code: string,
  detail: string,
  verifyAttempt?: Awaited<ReturnType<typeof verifySelfieProof>>,
) {
  pushEvent(record, {
    at: Date.now(),
    kind: "verification_failed",
    summary: `Verification failed — ${code}`,
    detail,
    source: "live",
    verifyStatus: verifyAttempt?.status ?? null,
  });
  saveAccount(record);

  const res = NextResponse.json({
    ok: false,
    errorCode: code,
    detail,
    verify: verifyAttempt
      ? {
          status: verifyAttempt.status,
          target: verifyAttempt.target,
          url: verifyAttempt.url,
          request: verifyAttempt.request,
          response: verifyAttempt.response,
        }
      : null,
  });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}
