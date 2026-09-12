# Selfie Check (Beta) — Integration Feedback

**Project:** Continuity Gate — a step-up authorization demo that treats Selfie Check as a
continuity and freshness signal rather than a personhood oracle.

| | |
|---|---|
| App | `plague` (team `noble`) |
| App ID | `app_3e8f709b907e4985aab5fa3b28269b00` |
| RP ID | `rp_e4636b70dd1ec3a9` |
| Action | `continuity-gate` (stable, never rotated) |
| SDK | `@worldcoin/idkit@4.2.3` / `idkit-core@4.2.4` |
| Verify path | `POST https://developer.world.org/api/v4/verify/{rp_id}` |
| Integration dates | 2026-09-10 → 2026-09-12 |

**Verified proof (the receipt this feedback is based on):**

```json
{
  "success": true,
  "action": "continuity-gate",
  "nullifier": "0x03a2968f5f00bd87862e0c7e6c3a46526605ef412db869bc21b92c3059654bd2",
  "created_at": "2026-09-12T14:21:28.96972+00:00",
  "environment": "production",
  "protocol_version": "3.0",
  "results": [{ "identifier": "selfie", "success": true, "nullifier": "0x03a2968f…654bd2" }]
}
```

A note on method: every claim below was checked against the live docs pages, the installed
`.d.ts` files, or a timestamped event in our own store. We started with 18 candidate findings
and **discarded 11** after checking (a twelfth, the v2 endpoint's behavior, was
unverified when first written and has since been measured — it is §1.4) — those are listed in §5 so you can see what we got wrong
about your docs, not just what we think your docs got wrong.

---

## 0. Top findings

| # | Finding | Severity |
|---|---|---|
| 1 | Selfie Check is only issuable on **3.0** — the 4.0 route returns `credential_unavailable`, and no page mentions protocol versions | **Blocker** |
| 2 | v4 requires `sybil_score`, which exists nowhere in the SDK and contradicts page 11 | **Blocker** |
| 3 | `allow_legacy_proofs` is a required boolean, undocumented, and the SDK's own examples disagree on its value | **Blocker** |
| 4 | IDKit accepts `environment: "sandbox"`; the verify API's `environment` enum has no `sandbox` value | **Blocker** |
| 5 | v4 requires an `integrity_bundle` "version 2" that the SDK marks optional | High |
| 6 | Sandbox needs a separate TestFlight build — the public World App cannot produce sandbox proofs | High |
| 7 | v2 answers `invalid_action` for every action on an RP-registered app, while the docs read as if it still works | High |
| 8 | No page states that `responses[].signal_hash === hash_to_field(signal)` | High |
| 9 | Credential `11` cannot be matched on in a legacy 3.0 proof — docs speak in numbers, the wire speaks in strings | High |
| 10 | The 90-day window is an *inactivity* window, but nothing says whether the nullifier survives re-enrollment | High |
| 11 | Docs tell everyone to email for access that is already enabled for all | Medium |
| 12 | `created_at` in the verify response is not the verification timestamp | Medium |
| 13 | `feature_unavailable` and `all_verifications_failed` are absent from the error-code reference | Medium |
| 14 | The sandbox page documents zero error codes and zero test users | Medium |

---

## 1. Selfie Check docs and integration flow

### 1.1 `allow_legacy_proofs` — required, undocumented, and self-contradicting  · Blocker

`IDKitRequestConfig` declares it non-optional:

```ts
// node_modules/@worldcoin/idkit-core/dist/index.d.ts:59
allow_legacy_proofs: boolean;   // no `?`, no default
```

Omitting it is a **compile error**. It must be `true` for Selfie Check, because
`selfieCheckLegacy()` only ever returns World ID 3.0 proofs — with `false` the request has
nothing valid to return.

Three problems:

1. `docs.world.org/world-id/credentials/11` never mentions it. Zero occurrences in the rendered
   page and in the `.md` source. The page ships **no code blocks at all**.
2. The SDK contradicts itself on the same call: the JSDoc for `selfieCheckLegacy`
   (`idkit-core/dist/index.d.ts:657-673`) uses `allow_legacy_proofs: true`, while the
   `idkit-core` README (`README.md:113-118`) uses `false` for the identical preset.
3. So the only way to learn the correct value is to reason about what `selfieCheckLegacy`
   returns and conclude the README example is wrong.

**Ask:** state it on page 11 with a code block, and fix the README to `true`.

### 1.2 Credential `11` is unmatched-able in a 3.0 proof  · High

Page 11's property table gives `| ID | 11 |` as the credential's only identifier, and `11` is
the URL slug. It appears nowhere else on the page, and no identifier *string* is shown anywhere
— zero occurrences of `credential_type`, `identifier`, or `verification_level`.

What `11` actually is: the `issuer_schema_id`, a **World ID 4.0-only** field
(`idkit-core/dist/index.d.ts:121-122`, documented `11=selfie`). `ResponseItemV3` has no numeric
field at all (`:127-139`), and `selfieCheckLegacy()` returns only 3.0. So there is no field in a
legacy Selfie Check proof where `11` can appear.

What is actually on the wire is `verification_level: "face"`, which the SDK rewrites to
`identifier: "selfie"` (`idkit-core/dist/index.js:2548`, `normalizeLegacyResponseIdentifier`).
We accept both spellings defensively, since we could not confirm that the WASM bridge path
applies the same normalization as the native path.

To be fair: the page never *claims* `11` appears in a payload, and it defers the wire format to
`/world-id/idkit/integrate`. But that page never mentions `selfie` or `face` either. So the net
effect is that **the docs give you no way to learn the value you must match on.** This is an
omission plus a vocabulary mismatch, not a false statement.

**Ask:** put the identifier string on page 11, next to the numeric ID.

### 1.3 `signal_hash` — the one link in the chain no page states  · High

`hash_to_field` *is* fully documented at `/world-id/idkit/signatures`, including the
Keccak-vs-SHA3 warning and test vectors. `hashSignal` *is* documented at
`/world-id/idkit/javascript`. Credit where due — we initially filed this as "undocumented" and
that was wrong.

The actual gap is narrower and sharper: **no page states that `responses[].signal_hash` equals
`hash_to_field(signal)`.** It is only inferable by noticing that the sample orb response's
`signal_hash` on `/world-id/idkit/integrate` is byte-identical to the documented
`hash_to_field("")` vector. Meanwhile the common-parameters table asserts the duty without the
means:

> **signal** — Binds app context into the proof, such as a user ID or wallet address.
> Your backend should enforce the same value.

Enforcing it is impossible without knowing the hash function, because only the hash comes back.
Get it wrong and every genuine proof is rejected as a cross-account replay — which is exactly
the `invalid_signal` rejection we logged at `2026-09-12T14:23:59.782Z`.

Two further traps, neither documented:

- **Import asymmetry.** `hashSignal` is *not* on the `@worldcoin/idkit` root (absent from the
  re-export list at `idkit/dist/index.d.ts:3`) and must come from `@worldcoin/idkit/hashing` —
  even though `idkit-core`'s root does export it, and even though the `idkit` root *does*
  re-export `signRequest` and `getSessionCommitment`. `hashSignal` is the one helper left off.
- **The `0x` branch.** A signal beginning `0x` whose remainder is valid even-length hex is
  decoded as **bytes**, not UTF-8 (`idkit-core/dist/hashing.js:5-24`). So
  `hashSignal("0xdead…")` hashes the bytes, not the string. The docs suggest "wallet address"
  as a signal — and every wallet address hits this branch. Our account ids are
  `acct_<hex>`, so we dodged it by luck.

One more thing worth flagging because it points the other way:
`/world-id/4-0-migration` says *"No longer reshape the payload or compute `signal_hash` for the
verify endpoint."* That is correct and we follow it — we pass the response item through
untouched. Re-deriving with `hashSignal` is needed **only** for the independent cross-account
binding check, which is the "enforce the same value" duty. The docs assert that duty in one
place and forbid the reshaping in another, without saying the two are different operations.

### 1.4 "`app_id` is still accepted for backward compatibility" is not true of v2  · High

The v4 reference says:

> Use `rp_id` (`rp_...`) when possible; `app_id` (`app_...`) is still accepted
> for backward compatibility.

That is about the **v4** path accepting either key. Read quickly — and it is easy
to read quickly — it suggests the legacy v2 endpoint remains a working fallback
for an RP-registered app. It does not.

Measured against this app, probing both endpoints with the same deliberately
invalid proof and the same configured action:

| Endpoint | Code returned | What it means |
|---|---|---|
| `POST /api/v4/verify/{rp_id}` | `all_verifications_failed` | reached cryptographic verification — config is correct |
| `POST /api/v2/verify/{app_id}` | `invalid_action` | never reached the proof at all |

v2 resolves the action against a registry that an RP-registered app does not
populate, so it answers `invalid_action` for **every** action — including one
that visibly exists in the portal. The failure is indistinguishable from a typo
in the action string, which is where the time goes: you check the action, the
portal, the spelling, and the casing, and none of it is the problem.

Worth noting the second-order effect: because v4 skips that registry, the
`max_verifications` cap a v2 action carries is not applied on the v4 path. That
is what makes a continuity gate viable — the same nullifier re-verifying
repeatedly is fine on v4, where on v2 it would eventually jam on
`already_verified`. Neither behavior is documented as a difference between the
endpoints.

**Ask:** say plainly on the verify reference that v2 is unusable once RP
registration is active, and make `invalid_action` name the registry as the
cause.

### 1.5 Selfie Check is documented as one credential but is only issuable on 3.0  · Blocker

This is the single most expensive thing we hit, and no page hints at it.

Selfie Check appears in the World ID 4.0 credential union, so the 4.0 route
type-checks and builds a valid request:

```ts
type CredentialType = "proof_of_human" | "selfie" | "passport" | "mnc";
CredentialRequest("selfie", { signal })   // valid 4.0 request
```

On a real device it cannot be satisfied. Same phone, same app, same human,
minutes apart:

| Route | Result |
|---|---|
| `selfieCheckLegacy()` → 3.0 | **HTTP 200**, `results[].selfie.success: true` |
| `CredentialRequest("selfie")` → 4.0 | **`credential_unavailable`** |

`credential_unavailable` means World App holds no such credential to present. So
the credential is enabled for the app, enrolled for the user, and verifiable —
but only in its 3.0 form. Nothing in the docs says this: **neither
`/world-id/credentials/11` nor `/world-id/sandbox/testing-selfie-check` mentions
a protocol version at all** (verified: zero occurrences of "3.0", "4.0" or
"legacy" in either page's body).

We only reached that conclusion by walking the v4 verify endpoint forward one
rejection at a time with a synthetic 4.0 body. Each step revealed a requirement
that is not documented anywhere:

| Probe result | Requirement discovered |
|---|---|
| `validation_error` — *"expires_at_min is required for v4"* | required field, at least declared in the SDK type |
| `validation_error` — *"sybil_score is required for Self Check 4.0 responses"* | **required field that exists nowhere in `@worldcoin/idkit@4.2.3`** |
| `integrity_verification_failed` — *"Self Check 4.0 responses require an integrity bundle signed with version 2"* | **result-level `integrity_bundle`, marked *optional* in the SDK, at an unspecified version** |

Three things follow, each worth fixing independently:

1. **`sybil_score` is unobtainable and contradicts the docs.** It appears in no
   `.d.ts`, no compiled JS, and not even in the WASM strings of idkit 4.2.3 — so
   a request assembled from the SDK's own `ResponseItemV4` can never satisfy the
   endpoint. It also directly contradicts page 11, which states Selfie Check
   *"returns a proof of the completed check, **not a numeric Sybil or uniqueness
   score**."* One of those two is wrong.
2. **`integrity_bundle` is optional in the type and required by the endpoint.**
   It is device-attested (Apple App Attest / Android Keystore plus an
   Attestation Gateway JWT), so it cannot be produced server-side, and it lives
   at the *result* level rather than on the credential entry — easy to drop
   while forwarding. No page states which World App version emits "version 2".
3. **The only workable client strategy is to forward the response item
   verbatim** — `responses: [{ ...item }]` — never to rebuild it from typed
   fields. This is World's own guidance (*"No longer reshape the payload ... for
   the verify endpoint"*, `/world-id/4-0-migration`), but that page frames it as
   a simplification rather than as the load-bearing requirement it is. Rebuilding
   from `ResponseItemV4` silently drops `sybil_score`, because there is no field
   to read it from.

**Asks:** state the issuable protocol version on page 11; publish `sybil_score`
in the SDK types or stop requiring it; mark `integrity_bundle` required for the
credentials that require it and say which World App version satisfies it; and
make `credential_unavailable` distinguish "you never enrolled" from "this
credential is not issued on the protocol version you asked for" — they are very
different problems with the same error code.

### 1.6 The v4 response's `created_at` is not the verification time  · Medium

A freshness gate is the obvious use for a timestamp in the verify response, and
`created_at` is the only one there. It does not mean what it looks like.

Re-verifying with a brand-new proof — fresh `rp_context` nonce, accepted, HTTP
200 — returned the **same `created_at`** as a verification two hours earlier. So
the field tracks the credential or nullifier, not the verify call. Using it as
"when this proof was verified" made a check completed seconds ago read as two
hours old, and correctly-configured 1-hour tiers denied it.

Nothing on the verify reference says what `created_at` is relative to. Since
`max_age` already enforces proof age server-side, the RP's own clock is the
right source for "when did I verify this" — but that is a conclusion you reach
after the bug, not from the docs.

**Ask:** document what `created_at` is measured from, or add a field that is
unambiguously the verification timestamp.

### 1.7 Nullifier semantics across the 90-day window are unspecified  · High

Page 11 says:

> Selfie Check has a 90-day inactivity window. After 90 days without use, the user completes
> the camera flow again before returning another proof.

So it is an **inactivity** window, not an absolute expiry — it resets on use. That is a
meaningful distinction and we initially modelled it wrong (as issuance + 90 days).

But the load-bearing question for any continuity product is never answered anywhere: **is the
nullifier stable across the 90-day window, and does it survive re-enrollment?** If
re-enrollment mints a fresh nullifier, then every continuity gate built on Selfie Check breaks
silently for any user who lapses — they return looking like a brand-new human, with no error.

This single fact determines whether Selfie Check is usable for continuity at all. It should be
on page 11 in bold.

### 1.8 What page 11 does *not* cover, and where it actually lives

Page 11 is a 4-section overview (Introduction / How it works / UX Flow / Next steps) with no
code. Everything an integrator needs is one to three hops away, and the page links to almost
none of it:

| Needed | Actually at | Linked from page 11? |
|---|---|---|
| Verify endpoint, host, schema | `/api-reference/developer-portal/verify` | No |
| `allow_legacy_proofs` | nowhere (type only) | — |
| Protocol version emitted | `/world-id/4-0-migration` (by inference) | No |
| `max_age` + bounds | `/world-id/reference/api.md:356` | No |
| `rp_context`, signing, `hash_to_field` | `/world-id/idkit/signatures` | **No** — two hops |
| Error codes | `/world-id/idkit/error-codes` | No |
| Identifier string | nowhere | — |

The RP-signatures omission is the costly one: page 11 states no signing requirement of its own,
so a reader can finish it believing none exists.

Also absent everywhere: on-chain verifiability (we assumed none and shipped accordingly), rate
limits, biometric-retention detail needed to write a privacy notice, and any MiniKit / World App
in-app guidance — page 11 documents only external deep-link and desktop-QR flows.

### 1.9 What worked well

- `selfieCheckLegacy({ signal })` as a preset is the right abstraction — one call, no
  credential-matrix reasoning.
- `signRequest` with a 300s default TTL is a sensible default and worked first try.
- The v4 `results[]` array is the right shape: per-credential outcomes mean a multi-credential
  request degrades legibly.
- The 4-step UX flow description on page 11 matched the real World App experience exactly,
  including the install-guidance branch for users without the app.

---

## 2. Developer Portal — navigation, search, discovery, debugging

### 2.1 Four gates, one of them invisible

Selfie Check has four independent prerequisites. We only learned this by building a preflight
probe. Three are self-service and verifiable locally; the fourth is neither:

| Gate | Self-service? | Verifiable before a user is at the camera? |
|---|---|---|
| Env vars present and well-formed | Yes | Yes |
| Signing key matches portal signer address | Yes | Yes — derive and compare |
| RP registration active | Yes | Yes — probe the verify endpoint |
| **Selfie Check feature flag** | **No** | **No** |

Our preflight derives the signer address from the signing key (secp256k1 + keccak) and compares
it to the portal's "Signer address" field. That catches a rotated or wrong-app key locally.
Without it, a key mismatch only ever appears as an opaque `invalid_rp_signature` from World App
— after the user has already been through a camera flow.

**This check should be a button in the portal.** You have both halves of the comparison.

### 2.2 The beta flag is the last thing to fail and the hardest to diagnose

Everything local passes, the portal looks correct, and the failure lands in front of a real
user. Worse:

- `feature_unavailable` is **absent from `/world-id/idkit/error-codes.md`**, despite shipping in
  the SDK enum. There is nothing to search for.
- No page names the error the disabled flag produces, so the flag → `feature_unavailable`
  mapping is our own inference.
- The request channel is inconsistent: `credentials/11` and `/world-id/idkit/credentials` both
  give `mailto:developers@toolsforhumanity.com`; the sandbox page says to go through "your World
  point of contact" instead. For an app with no named rep, those are not obviously the same
  thing.
- No turnaround time and no approval criteria are published.

**Ask:** publish the error code, show the flag's state in the portal, and pick one channel.

### 2.3 We had to probe the portal to read our own configuration

There is no endpoint that answers "is my app configured correctly?" So we POST a deliberately
invalid all-zero proof to `/api/v4/verify/{rp_id}` and classify on which error comes back —
`all_verifications_failed` means the app and RP registration are fine and we reached
cryptographic verification. A forged proof returned `HTTP 400` with
`results[{identifier:"selfie", success:false, code:"invalid_merkle_root"}]`, which is how we
confirmed RP registration was active before we had a real proof.

This works, but it is a hack against a production endpoint, and nothing says whether repeated
bogus proofs count against the app's quota. A read-only config/status endpoint would remove the
need entirely.

### 2.4 Debugging affordances that don't exist

- No request IDs or correlation IDs on verify responses, so a failure cannot be taken to support
  as anything more specific than a timestamp.
- No request log in the portal — we could not see our own verify attempts.
- No way to see which environment an `rp_id` resolves to (see §3.1).
- Portal screens aren't named in any setup docs. `WORLD_RP_SIGNER_ADDRESS` is documented as
  coming from "World ID Configuration"; `app_id` and `rp_id` are documented only as coming from
  "developer.world.org". Naming the screen per value would save every integrator the hunt.
- `rp_id` is typed as a bare `string`, not `` `rp_${string}` `` the way `app_id` is. The prefix
  rule exists only as a WASM runtime error (`"Invalid RP ID: must start with rp_"`). Free
  compile-time help, left on the table.

---

## 3. Sandbox — states, proof flows, test users, errors, edge cases

### 3.1 `environment: "sandbox"` has nowhere to go on the verify side  · Blocker

This is the most serious finding in this document.

**The mint side has three environments.** `idkit-core/dist/index.d.ts:64-65`:

```ts
environment?: "production" | "staging" | "sandbox";   // default "production"
```

It selects the World App connect base URL — `world.org/verify`,
`staging.world.org/verify`, `sandbox.world.org/verify` (literals in `idkit_wasm_bg.wasm`).

**The verify side has two.** The v4 reference documents `environment` on every request variant
including the legacy one Selfie Check emits (`VerifyV4LegacyProofRequest`), as
`enum: [production, staging], default: production`. **`sandbox` appears nowhere on that page.**

So a proof minted at `environment: "sandbox"` has no environment value to be verified under and
falls through to the production default. Nothing in the request or the response tells you the
two halves disagree. The only symptom is `invalid_merkle_root`, whose natural reading is
"this credential isn't verified" — which sends you to re-enroll the user instead of aligning
environments.

Meanwhile the sandbox page claims sandbox exercises

> the full relying-party journey — request handoff, consent, capture, enrollment and matching,
> proof generation, and delivery of the proof

and lets you test "without touching production identities or real proofs" — while documenting
**no environment switch whatsoever**: no IDKit prop, no portal toggle, no verify field, no
per-environment host, no `app_id`/`rp_id` prefix rule. It says nothing at all about verifying
the resulting proof. So a reader is told that delivery of a real proof is in scope, and is never
told that the field which would carry it through verification has no sandbox value.

**What we observed, stated precisely.** Our widget is hardcoded `environment="sandbox"`
([app/face/live-widget.tsx:48](app/face/live-widget.tsx#L48)) while our verify call always POSTs
to the single host with no environment field. One genuine proof verified at
`14:21:28.768Z`, and two real portal rejections with `invalid_merkle_root` followed at
`14:23:59.763Z` and `14:24:00.818Z`.

We are **not** claiming the environment mismatch caused those two rejections. Our store persists
only a summary string per event, not the response body, and those failures arrived in a
sub-second burst alongside `invalid_signal` and `unexpected_response` — a pattern that points at
replayed or hand-crafted payloads whose merkle root would be rejected regardless. What we *are*
claiming is the structural hazard: **sandbox in, production-default out, with no API surface
that reveals the asymmetry.** The `invalid_merkle_root` guidance we wrote for ourselves names
this exact mismatch, which is how we found it.

**Asks:** add `sandbox` to the verify `environment` enum or document why it is absent; echo the
resolved environment in the verify response; and say on the sandbox page where the switch lives.

### 3.2 Sandbox needs a separate app build, and that is easy to miss  · High

The sandbox page says the sandbox World ID app is distributed via **TestFlight
(iOS)** or a **private Google Play testing link**, and is not in the public app
stores. That is the single most important operational fact on the page, and it is
one row in a prose paragraph rather than a prerequisite at the top.

The consequence, which we got wrong for most of the integration: setting
`environment: "sandbox"` in IDKit while scanning with the **public** World App is
not a sandbox test. IDKit happily points at `sandbox.world.org`, the public
production client completes the flow anyway, and the resulting proof verifies
with `"environment": "production"` in the response. Nothing errors. We shipped a
hardcoded `environment="sandbox"` for days while every proof was a production
proof, and only noticed by reading the verify response body.

It compounds with §3.1: because the page documents no environment switch at all,
there is nothing to cross-check the app build against.

**Asks:** put the TestFlight/private-Play requirement in a prerequisites callout
at the top of the sandbox page; state plainly that the public World App cannot
produce sandbox proofs; and have IDKit warn (or the endpoint reject) when a
production client answers a sandbox request, instead of silently producing a
production proof.

### 3.3 There are no test users

The sandbox page never says whether test users exist. We found:

- no pre-seeded or fixture accounts
- no way to create a test identity on demand
- no way to reset or re-provision one
- no way to force a specific user state other than physically having a different human

For a **biometric** credential this is the central testing problem. The two states that matter
most for a continuity product are "same human returns" and "different human passes liveness",
and the second one is untestable without recruiting a second person. Cold onboarding needs an
invite code (iOS), and the page does not say how a tester obtains one for sandbox, whether codes
are reusable, or how many are issued.

**We had to build a local proof engine to test at all.** 15 scenarios emitting the same World ID
3.0 payload shape: 3 user states (hot / cold / semi-cold), a second human passing liveness on an
existing account, backdated proofs at 3h and 9d, an expiring credential, and 8 World App error
codes. It is honestly labelled as not producing real Semaphore nullifiers. Every policy edge in
our app was developed against it, because the sandbox could not produce any of these states on
demand.

**Ask:** seeded test identities with selectable states would remove the need for every RP to
build this. Failing that, say plainly that face capture requires a real human and real camera,
so nobody budgets for automated testing.

### 3.4 The sandbox page documents zero error codes

No error enum, no error table, no verification-failure codes, no cancellation handling, no
retry/backoff guidance, no description of what the user sees on a failed face match, and no
lockout or rate-limit behavior after repeated failures. For a page whose purpose is testing,
this is the biggest single omission — the errors *are* the thing you are testing for.

### 3.5 Errors we actually hit

Distinguishing real from simulated matters here, so: codes below are marked **live** only when
they are unreachable from our mock engine and therefore came from the real path.

| Code | Source | When (UTC, 2026-09-12) | Note |
|---|---|---|---|
| `invalid_merkle_root` | **live** | 14:23:59.763, 14:24:00.818 | Also seen from our forged-proof preflight probe |
| `unexpected_response` | **live** | 14:23:59.794 | A **4.0** result arrived where 3.0 was expected |
| `invalid_signal` | **live** | 14:23:59.782 | Our own cross-account binding guard |
| `all_verifications_failed` | **live** | preflight | Absent from every published error list — and it is the code that means *your config is correct* |
| `credential_unavailable` | **live** | 2026-09-13 | On the 4.0 route, while 3.0 verified minutes earlier. Same code is documented as "never enrolled" — see §1.5 |
| `validation_error` ×2 | **live** | preflight | `expires_at_min` then `sybil_score` required for a 4.0 Selfie Check response |
| `integrity_verification_failed` | **live** | preflight | Requires an integrity bundle "signed with version 2" |
| `feature_unavailable` | simulated | — | Not in the canonical error-code reference |
| `user_rejected`, `verification_rejected`, `credential_unavailable`, `max_verifications_reached`, `invalid_rp_signature`, `rp_signature_expired`, `connection_failed` | simulated | — | Reproduced locally because sandbox cannot trigger them on demand |

Two observations from that table:

- **`all_verifications_failed` is the code that proves your configuration works**, and it is
  published nowhere. It is the single most useful string in the whole integration and we found
  it by accident.
- **A 4.0 result arrived from a Selfie Check request.** We could not determine from our stored
  data whether that came from a genuine World App session or a hand-crafted body, so we are not
  claiming World App emits 4.0 for `selfieCheckLegacy`. But since no page states which protocol
  version Selfie Check emits, we had no documented basis for rejecting it either — we had to
  infer 3.0-only from the SDK JSDoc and gate on it defensively.

### 3.6 Edge cases with no sandbox coverage

Proof freshness (`max_age`), credential aging toward the 90-day boundary, continuity breaks, and
nonce replay all had to be simulated. `duplicate_nonce` is reachable in our code but never fired
in sandbox. We also never established whether sandbox actions are separate objects from
production actions, or whether an action must be pre-registered for v4 at all.

---

## 4. What was confusing, missing, broken, or hard to test

**Confusing**

| Thing | Why |
|---|---|
| Credential identity | Docs speak in numbers (`11`), the 3.0 wire speaks in strings (`face` → `selfie`). Neither vocabulary appears on the other's page. |
| Which environment you are in | Three values on mint, two on verify, nothing echoed back. |
| `allow_legacy_proofs` | Required by the type, absent from the docs, `true` in the JSDoc and `false` in the README. |
| Two error-code sets | `IDKitErrorCode` (26 members) and `IDKitErrorCodes` (29) ship in the same SDK with no note on which is which. Widgets surface the enum, so `invalid_rp_id_format`, `timeout` and `cancelled` can only arrive that way. |
| `signal_hash` duty | Told to "enforce the same value" in one place; told not to compute `signal_hash` in another. They are different operations and nothing says so. |

**Missing**

- Nullifier stability across the 90-day inactivity window and across re-enrollment — the fact a
  continuity product is built on.
- The identifier string on page 11.
- `feature_unavailable` and `all_verifications_failed` in the error-code reference.
- `sandbox` in the verify `environment` enum.
- Test users, or a statement that none exist.
- Any error codes at all on the sandbox page.
- Request IDs, a portal request log, or any observability for a failed run.
- A sandbox → production migration checklist.
- Rate limits, pricing, and whether preflight probes count against quota.
- Biometric retention specifics needed to write an RP privacy notice.

**Broken / misleading**

- `idkit-core` README: `allow_legacy_proofs: false` for `selfieCheckLegacy` cannot work.
- `idkit-core` README backend quickstart destructures `const { success } = await response.json()`.
  On v4, HTTP 200 means *at least one* proof verified, so copying that line verbatim accepts a
  request whose Selfie Check credential failed. We require the `selfie` entry in `results[]` to
  have succeeded. The README pattern is unsafe for any multi-credential request.
- README verify host (`developer.worldcoin.org`) differs from the host that answers
  (`developer.world.org`).
- Legacy preset *types* (`SelfieCheckLegacyPreset` et al.) are not re-exported from
  `@worldcoin/idkit` although the *factory functions* are.
- `action: AbiEncodedValue | string` — `AbiEncodedValue` is a branded type with no exported
  constructor anywhere in the SDK, so that arm is uninhabitable from user code.
- No client-side `rp_context` expiry check: the JS layer validates only presence, never compares
  `expires_at` to now. An expired context fails late and opaquely instead of at construction.

**Broken / misleading (continued)**

- Page 11 tells you to email for access that is already enabled for everyone
  (§2.2).
- `credential_unavailable` conflates "user never enrolled" with "this credential
  is not issued on the protocol version you requested".
- `created_at` in the verify response is not the verification timestamp (§1.6).

**Hard to test**

1. A second human passing liveness — the core abuse case, and it needs a second human.
2. Proof aging — no way to backdate a proof, so `max_age` tiers are untestable live.
3. The beta flag — unprobeable by design, so it cannot be covered before launch.
4. Anything in CI — face capture needs a real camera and no page says so.
5. Environment alignment — unverifiable before shipping, because nothing echoes the environment.

---

## 5. Findings we discarded after checking

We think this section matters as much as the rest: these are things we believed after our first
pass and then disproved. Several were wrong *because the docs were better than we assumed*.

| We initially thought | Actually |
|---|---|
| `max_age` bounds are undocumented | Documented at `/world-id/reference/api.md:356` as `minimum: 3600, maximum: 604800`. Our constants match exactly. |
| The `face` → `selfie` alias is undocumented | Documented in the v4 API reference: *"Use `selfie` for Selfie Check (Beta); the historical `face` value remains accepted."* |
| `hash_to_field` is undocumented | Fully documented at `/world-id/idkit/signatures`, with the Keccak-vs-SHA3 warning and test vectors. Only the `signal_hash` linkage is missing. |
| `rp_context` and its TTL are undocumented | Documented at `/world-id/idkit/signatures`. The gap is only that the two Selfie-Check-specific pages never mention it. |
| v4 silently skips the `max_verifications` cap | The two endpoints document different error sets; we could not show v4 ignores a cap that was actually configured. Endpoint-routing nuance, not a defect. |
| The 26-vs-29 error-code split is a docs bug | Real divergence, but a version-freshness issue rather than a documentation contradiction. |

The pattern: **the reference docs are good; the Selfie Check pages don't link to them.** Page 11
and the sandbox page are both short overviews that defer nearly everything, and the deferral
targets are mostly unlinked. Fixing the link graph would resolve a majority of what we hit.

---

## 6. Prioritized asks

1. **State on page 11 which protocol version Selfie Check is issuable on.** The
   4.0 route type-checks and returns `credential_unavailable` on a real device;
   nothing in the docs mentions protocol versions. — *this cost us the most time*
2. **Resolve `sybil_score`:** publish it in the SDK types, or stop requiring it
   on the verify endpoint, or correct page 11's "not a numeric Sybil score".
   Right now all three cannot be true at once.
3. **Mark `integrity_bundle` required** where it is required, and say which World
   App version emits "version 2".
4. Add `sandbox` to the verify `environment` enum or document its absence, and
   echo the resolved environment in every verify response.
5. **Put the TestFlight/private-Play requirement at the top of the sandbox
   page,** and say plainly that the public World App cannot produce sandbox
   proofs.
6. **Update the "access-gated / request access" callouts** now that Selfie Check
   is enabled for everyone — or keep them and stop telling people otherwise in
   chat.
7. Publish `feature_unavailable`, `all_verifications_failed` and
   `validation_error` in the error-code reference. Split
   `credential_unavailable` into "not enrolled" vs "not issued on this protocol
   version".
8. Say what `created_at` is measured from, or add a true verification timestamp.
9. Provide sandbox test identities with selectable states — or say plainly that a
   real human and real camera are required.
10. Link page 11 to `/world-id/idkit/signatures`,
    `/api-reference/developer-portal/verify`, `/world-id/idkit/error-codes`, and
    `/world-id/sandbox/sandbox-access`.
11. Fix `allow_legacy_proofs: false` and the `const { success }` quickstart in
    the `idkit-core` README, and correct the verify host.

## Appendix — what we built

Selfie Check is treated as a **continuity and freshness** signal, never as personhood. The
credential is medium-assurance and does not promise one-person-one-account, so the app uses the
two properties it genuinely has:

- **Continuity** — the nullifier is deterministic for a given (credential, app_id, action), so
  re-verifying yields the same value for the same human. That answers "is the person holding
  this account still the person who opened it?"
- **Freshness** — `max_age` lets each action demand a proof minted inside its own window. A
  90-day credential is not a 90-day session.

Four actions across three tiers: `view_balance` (open, no signal), `update_recovery_email`
(sensitive, `max_age=604800`), `withdraw` and `recover_device` (critical, `max_age=3600`). A
continuity break routes to manual review rather than a retry, because a fresh selfie cannot
clear a medium-assurance mismatch.

**Final shipped configuration**, and why each value is what it is:

| Setting | Value | Reason |
|---|---|---|
| Protocol | 3.0 via `selfieCheckLegacy()` | the only version Selfie Check is issuable on (§1.5) |
| `allow_legacy_proofs` | `true` | the preset only produces 3.0; `false` leaves nothing to return |
| Verify endpoint | `/api/v4/verify/{rp_id}` | v2 answers `invalid_action` on an RP-registered app (§1.4) |
| `WORLD_ENVIRONMENT` | `production` | the public World App is a production client; sandbox needs the TestFlight build (§3.2) |
| Accepted versions | exactly one | 3.0 and 4.0 nullifiers are different unlinkable values, so accepting both allows two anchors per human |

The integration constraint that took longest to internalize, and which no page warns about: the
**action string must be stable across sessions.** Nullifiers are action-scoped, so rotating the
action — the natural instinct if you read it as a per-request nonce — silently destroys
continuity. Every returning user looks brand new and nothing errors. The per-request nonce
belongs in `rp_context`.
