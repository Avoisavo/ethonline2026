// pages/api/hedera.ts
// ════════════════════════════════════════════════════════════════════════════
// MARS — single consolidated Hedera API route. POST { action, ...params }.
// Every capability in lib/hedera.ts is exposed here via `action`. To trim a
// standard, delete its lib/hedera.ts block AND the matching case(s) below.
//
//   curl -X POST localhost:3000/api/hedera -H 'content-type: application/json' \
//        -d '{"action":"createAccount"}'
// ════════════════════════════════════════════════════════════════════════════

import type { NextApiRequest, NextApiResponse } from "next";
import { createHash } from "node:crypto";
import { Client, PrivateKey } from "@hashgraph/sdk";
import {
  getClient,
  getOperatorKey,
  getOperatorId,
  // accounts
  createAgentAccount,
  // topics
  createTopic,
  submitMessage,
  readTopicMessages,
  // HTS
  createVerifiedCollection,
  createLicenseCollection,
  mintNft,
  checkNft,
  associateToken,
  transferNft,
  // HCS-1 files
  uploadFileHCS1,
  downloadFileHCS1,
  // HCS-2 registry
  hcs2Memo,
  buildHCS2Register,
  computeHCS2State,
  // HCS-26 skills registry
  hcs26DiscoveryMemo,
  hcs26VersionMemo,
  buildHCS26SkillRegister,
  buildHCS26VersionRegister,
  buildSkillManifest,
  // HCS-25 trust score
  computeTrustScore,
  buildTrustScoreMessage,
  // HCS-18 RFQ board
  hcs18Memo,
  buildHCS18Announce,
  buildHCS18Propose,
  buildHCS18Respond,
  buildHCS18Complete,
  buildHCS18Withdraw,
  // HCS-16 Flora room
  hcs16Memo,
  buildHCS16FloraCreated,
  buildHCS16Chat,
  // HCS-11 profile
  hcs11AccountMemo,
  buildHCS11Profile,
  // HCS-20 reputation
  HCS20_MEMO,
  buildHCS20Deploy,
  buildHCS20Mint,
  buildHCS20Transfer,
  buildHCS20Burn,
  computeHCS20Balances,
  computeReputation,
  // reviews & ratings
  buildReview,
  computeReviews,
  // main registry (orchestration)
  buildJobPosted,
  buildJobUpdated,
  buildHumanVerified,
  computeRegistry,
  // audit trail + schedule
  buildAuditStep,
  buildAuditVerdict,
  buildTaskInit,
  scheduleReAudit,
} from "@/lib/hederaone/hedera";
import { checkAgentHuman } from "@/lib/hederaone/world-agentkit";
import { registerAgent as registerAgentFlow, initMars } from "@/lib/hederaone/agents";
import { loadState, saveState } from "@/lib/hederaone/state";
import { loadDemoSkill } from "@/lib/hederaone/demo-skills-loader";
import { getSkill, SKILL_DESCRIPTIONS } from "@/lib/hederaone/demo-skills";
import { generateAuditorQuote } from "@/lib/hederaone/auditor";
import { auditTaskToHcs, finalizeTaskToHcs } from "@/lib/hederaone/audit-task";
import { savePremiumSkill } from "@/lib/hederaone/db.mjs";
import { resolveRemoteSkill, resolveLocalDemoSkill } from "@/lib/hederaone/skill-source.mjs";

export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } }, // audit reports / manifests can be large
  maxDuration: 300, // runAudit = 4 OpenAI stages + several HCS writes; needs headroom
};

// World ID agentkit: is an address human-backed? Fails soft — never blocks account creation.
async function worldCheck(address?: string): Promise<{ worldVerified: boolean; humanId: string | null }> {
  if (!address) return { worldVerified: false, humanId: null };
  try {
    const humanId = await checkAgentHuman(address);
    return { worldVerified: humanId !== null, humanId };
  } catch {
    return { worldVerified: false, humanId: null };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body ?? {};
  const { action } = body;
  let client: Client | undefined;

  try {
    client = getClient();
    const submitKey = getOperatorKey().publicKey;

    switch (action) {
      // ── ACCOUNTS ──────────────────────────────────────────────
      case "createAccount": {
        const acct = await createAgentAccount(client, body.initialBalance);
        const world = await worldCheck(body.worldAddress ?? acct.evmAddress); // anti-sybil
        return res.status(200).json({ ...acct, ...world });
      }
      case "worldCheck": {
        // run the World agentkit lookup on any address: is it human-backed in AgentBook?
        return res.status(200).json({ address: body.address, ...(await worldCheck(body.address)) });
      }

      // ── GENERIC TOPIC ─────────────────────────────────────────
      case "createTopic": {
        const topicId = await createTopic(client, body.memo ?? "mars-topic", body.submitKey ? submitKey : undefined);
        return res.status(200).json({ topicId });
      }
      case "submitMessage": {
        return res.status(200).json(await submitMessage(client, body.topicId, body.message));
      }
      case "readTopic": {
        return res.status(200).json({ messages: await readTopicMessages(body.topicId, body.limit ?? 100) });
      }

      // ── HTS: VERIFIED NFT + LICENSE NFT ───────────────────────
      case "createVerifiedCollection": {
        return res.status(200).json(await createVerifiedCollection(client, body.name, body.symbol));
      }
      case "createLicenseCollection": {
        // optional author royalty: pass royaltyCollectorAccountId + numerator/denominator
        return res.status(200).json(await createLicenseCollection(client, {
          name: body.name, symbol: body.symbol,
          royaltyCollectorAccountId: body.royaltyCollectorAccountId,
          numerator: body.numerator, denominator: body.denominator, fallbackHbar: body.fallbackHbar,
        }));
      }
      case "mintNft": {
        // metadata encodes the skill + version so checkNft can read it back (≤100 bytes)
        const metadata = body.metadata ?? JSON.stringify({ skill: body.skill, version: body.version, ...(body.reportHrl && { report: body.reportHrl }) });
        const minted = await mintNft(client, body.tokenId, metadata);
        return res.status(200).json({ ...minted, metadata });
      }
      case "checkNft": {
        // "do we have an NFT for this version, who owns it, what skill is it?"
        return res.status(200).json(await checkNft(body.tokenId, { serial: body.serial, account: body.account, version: body.version }));
      }
      case "associateToken": {
        const key = PrivateKey.fromStringDer(body.accountKey);
        return res.status(200).json(await associateToken(client, body.tokenId, body.accountId, key));
      }
      case "transferNft": {
        return res.status(200).json(await transferNft(client, body.tokenId, body.serial, body.toAccountId));
      }

      // ── HCS-1: FILE STORAGE (audit report / manifest) ─────────
      case "uploadReport": {
        const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content);
        return res.status(200).json(await uploadFileHCS1(client, content, body.mimeType));
      }
      case "downloadReport": {
        return res.status(200).json(await downloadFileHCS1(body.topicId));
      }

      // ── HCS-2: TOPIC REGISTRY ─────────────────────────────────
      case "createRegistry": {
        const topicId = await createTopic(client, hcs2Memo(body.indexed, body.ttl), submitKey);
        return res.status(200).json({ topicId, memo: hcs2Memo(body.indexed, body.ttl) });
      }
      case "registerInRegistry": {
        const r = await submitMessage(client, body.registryTopicId, buildHCS2Register(body.t_id, body.metadata, body.m));
        return res.status(200).json({ ...r, uid: r.sequenceNumber });
      }
      case "readRegistry": {
        return res.status(200).json({ entries: computeHCS2State(await readTopicMessages(body.registryTopicId, body.limit ?? 1000)) });
      }

      // ── MARS MAIN REGISTRY (orchestration: agents + jobs index) ─
      case "createMainRegistry": {
        const topicId = await createTopic(client, hcs2Memo(), submitKey);
        return res.status(200).json({ topicId, memo: hcs2Memo() });
      }
      case "initMars": {
        // ensures all shared infra (seeded to mars-state.json + reused): registry + voting + reviews
        return res.status(200).json(await initMars(client, { force: body.force }));
      }
      case "getMars": {
        // the seeded main-registry ids (or {} if not seeded yet) — lets the UI run setup as discrete steps
        return res.status(200).json(loadState());
      }
      case "saveMars": {
        // persist the seeded infra ids after the UI created them step-by-step
        return res.status(200).json(saveState({ registryTopicId: body.registryTopicId, votingTopicId: body.votingTopicId, reviewTopicId: body.reviewTopicId }));
      }
      case "registerAgent": {
        // full agent onboarding (account + World + profile + memo + registry + encrypted key) — lib/agents
        return res.status(200).json(
          await registerAgentFlow(client, {
            registryTopicId: body.registryTopicId,
            role: body.role,
            bio: body.bio,
            capabilities: body.capabilities,
            model: body.model,
            initialBalance: body.initialBalance,
            accountId: body.accountId,
            worldAddress: body.worldAddress,
            worldVerified: body.worldVerified,
            humanId: body.humanId,
          })
        );
      }
      case "startJob": {
        // create the job's own audit-trail sub-topic → log the job into the main registry
        const auditTrailTopicId = await createTopic(client, `mars-audit:${body.skill ?? "skill"}`, submitKey);
        const jobId = body.jobId ?? auditTrailTopicId;
        const reg = await submitMessage(client, body.registryTopicId, buildJobPosted({ jobId, skill: body.skill, requester: body.requester, scope: body.scope, auditTrailTopicId, status: "open" }));
        return res.status(200).json({ jobId, auditTrailTopicId, registrySeq: reg.sequenceNumber });
      }
      case "updateJob": {
        return res.status(200).json(await submitMessage(client, body.registryTopicId, buildJobUpdated({ jobId: body.jobId, status: body.status, auditor: body.auditor, verdict: body.verdict, trustScore: body.trustScore, note: body.note })));
      }
      case "readMainRegistry": {
        return res.status(200).json(computeRegistry(await readTopicMessages(body.registryTopicId, body.limit ?? 1000)));
      }
      case "logHumanVerified": {
        // log a completed World ID verification (verifier nullifier / evm hash) into the main HCS registry
        return res.status(200).json(await submitMessage(client, body.registryTopicId, buildHumanVerified(body.nullifier, { evmAddress: body.evmAddress, signalHash: body.signalHash, account: body.account })));
      }

      // ── HCS-26: SKILLS REGISTRY ───────────────────────────────
      case "createSkillsRegistry": {
        const topicId = await createTopic(client, hcs26DiscoveryMemo(), submitKey);
        return res.status(200).json({ topicId, memo: hcs26DiscoveryMemo() });
      }
      case "createVersionRegistry": {
        const topicId = await createTopic(client, hcs26VersionMemo(), submitKey);
        return res.status(200).json({ topicId, memo: hcs26VersionMemo() });
      }
      case "registerSkill": {
        // body.metadata = SkillMetadata. Returns the consensus seq# (= skill_uid).
        const r = await submitMessage(client, body.discoveryTopicId, buildHCS26SkillRegister(body.versionRegistryTopicId, body.accountId, body.metadata, body.m));
        return res.status(200).json({ ...r, skill_uid: r.sequenceNumber });
      }
      case "registerVersion": {
        const r = await submitMessage(client, body.versionRegistryTopicId, buildHCS26VersionRegister(body.skillUid, body.version, body.manifestTopicId, body.checksum, body.status, body.m));
        return res.status(200).json({ ...r, version_uid: r.sequenceNumber });
      }
      case "uploadManifest": {
        // build a SKILL.json (requires a root SKILL.md file entry) and store it on HCS-1
        const manifest = buildSkillManifest(body);
        return res.status(200).json(await uploadFileHCS1(client, manifest));
      }

      // ── HCS-25: TRUST SCORE ───────────────────────────────────
      case "trustScore": {
        const score = computeTrustScore(body.adapters ?? [], body.configVersion, body.confidence);
        let posted = null;
        if (body.topicId && body.skillId) {
          posted = await submitMessage(client, body.topicId, buildTrustScoreMessage(body.skillId, score));
        }
        return res.status(200).json({ score, posted });
      }

      // ── HCS-18: RFQ / DISCOVERY BOARD ─────────────────────────
      case "createRfqBoard": {
        // open, submit-keyless board (anyone can announce/quote)
        const topicId = await createTopic(client, hcs18Memo(body.indexed, body.ttl));
        return res.status(200).json({ topicId, memo: hcs18Memo(body.indexed, body.ttl) });
      }
      case "rfqAnnounce": {
        return res.status(200).json(await submitMessage(client, body.boardTopicId, buildHCS18Announce(body.petal, body.capabilities, body.uaid, body.valid_for)));
      }
      case "rfqPropose": {
        // the open audit job — its seq# is the RFQ id
        const r = await submitMessage(client, body.boardTopicId, buildHCS18Propose(body.members ?? [], body.config, body.existing_flora));
        return res.status(200).json({ ...r, proposal_seq: r.sequenceNumber });
      }
      case "rfqRespond": {
        // auditor quote (decision accept/reject)
        return res.status(200).json(await submitMessage(client, body.boardTopicId, buildHCS18Respond(body.proposal_seq, body.decision, body.reason, body.accepted_seq)));
      }
      case "rfqComplete": {
        // requester selects + links the HCS-16 Flora room
        return res.status(200).json(await submitMessage(client, body.boardTopicId, buildHCS18Complete(body.proposal_seq, body.flora_account_id, body.topics)));
      }
      case "rfqWithdraw": {
        return res.status(200).json(await submitMessage(client, body.boardTopicId, buildHCS18Withdraw(body.announce_seq, body.reason)));
      }
      case "rfqList": {
        return res.status(200).json({ messages: await readTopicMessages(body.boardTopicId, body.limit ?? 1000) });
      }

      // ── HCS-16: FLORA COMMS ROOM ──────────────────────────────
      case "createFlora": {
        const floraAccountId = body.floraAccountId ?? getOperatorKey().publicKey.toString();
        const fid = body.floraAccountId ?? "mars-flora";
        const communication = await createTopic(client, hcs16Memo(fid, 0), submitKey);
        const transaction = await createTopic(client, hcs16Memo(fid, 1), submitKey);
        const state = await createTopic(client, hcs16Memo(fid, 2), submitKey);
        await submitMessage(client, communication, buildHCS16FloraCreated(floraAccountId, communication, transaction, state));
        return res.status(200).json({ floraAccountId, topics: { communication, transaction, state } });
      }
      case "floraChat": {
        return res.status(200).json(await submitMessage(client, body.commsTopicId, buildHCS16Chat(body.senderId, body.floraAccountId, body.data)));
      }
      case "floraRead": {
        return res.status(200).json({ messages: await readTopicMessages(body.topicId, body.limit ?? 1000) });
      }

      // ── /chatroom: ONE global HCS-16 negotiation room (seeded + reused) ──
      case "ensureChatRoom": {
        const st = loadState();
        if (st.chatRoomTopicId) {
          return res.status(200).json({ chatRoomTopicId: st.chatRoomTopicId, floraId: st.chatFloraId ?? "mars-chatroom", seeded: true });
        }
        const floraId = "mars-chatroom";
        const communication = await createTopic(client, hcs16Memo(floraId, 0), submitKey);
        // marker (op:"flora_created", NOT a chat bubble) so the room is non-empty on first read
        await submitMessage(client, communication, buildHCS16FloraCreated(getOperatorId(), communication, communication, communication, "MARS negotiation room"));
        saveState({ chatRoomTopicId: communication, chatFloraId: floraId });
        return res.status(200).json({ chatRoomTopicId: communication, floraId, seeded: false });
      }

      // ── /chatroom: the auditor's quote, generated by OpenAI (auditor only) ──
      case "auditorReply": {
        const skill = getSkill(body.skillRef ?? body.skill ?? "");
        if (!skill) return res.status(400).json({ error: `unknown skill "${body.skillRef ?? body.skill}"` });
        return res.status(200).json(await generateAuditorQuote(skill, body.ask));
      }

      // ── resolve a skill REFERENCE (demo name · npm package · github/raw URL) → { name, files } ──
      // Lets the /publish UI ingest skills the user doesn't paste/upload (their repo / npm).
      case "resolveSkill": {
        const ref = String(body.ref ?? body.skillRef ?? "").trim();
        if (!ref) return res.status(400).json({ error: "ref required" });
        try {
          const resolved = resolveLocalDemoSkill(ref) ?? (await resolveRemoteSkill(ref));
          return res.status(200).json({ name: resolved.name, files: resolved.files });
        } catch (e) {
          return res.status(400).json({ error: e instanceof Error ? e.message : "could not resolve skill" });
        }
      }

      // ── /chatroom + /publish: accept the quote → spin the per-task topic + log the job ──
      case "createTask": {
        // Author-submitted source (paste/upload/URL) arrives as body.content; otherwise the
        // skill is a demo ref read SERVER-SIDE from demo/skills so `init` stays authoritative.
        const skillRef: string = body.skillRef ?? body.skillFile ?? "price-checker.js";
        const inline = typeof body.content === "string" && body.content.trim() ? body.content : "";
        const loaded = inline ? { name: body.skill ?? "skill", source: inline, files: [] as string[] } : loadDemoSkill(skillRef);
        const skill: string = body.skill ?? loaded.name;
        const source = loaded.source;
        const contentHash = createHash("sha256").update(source).digest("hex");
        const terms = {
          skill,
          description: SKILL_DESCRIPTIONS[skillRef] ?? body.description, // what the skill CLAIMS to do
          files: loaded.files, // the file(s) submitted for audit
          scope: body.scope ?? "network · keys · wallet",
          requester: body.requester, // = the payer
          auditor: body.auditor,
          price: body.price ?? "—",
          bond: body.bond ?? "—",
          time: body.time ?? "—",
          version: body.version,
          tier: body.tier,
          compliance: body.compliance,
          contentHash,
          chatRoomTopicId: body.chatRoomTopicId,
          m: body.quote, // the auditor's actual (AI) quote line → the nego record lives on the task topic too
        };
        // inline the source if `init` stays under the 1KB HCS message limit; else offload to HCS-1
        let content = source;
        let contentHrl: string | undefined;
        if (Buffer.byteLength(buildTaskInit({ ...terms, content: source }), "utf-8") > 1000) {
          const file = await uploadFileHCS1(client, source, "application/javascript");
          content = file.hrl;
          contentHrl = file.hrl;
        }
        const taskTopicId = await createTopic(client, `mars-task:${skill}`, submitKey);
        const init = buildTaskInit({ ...terms, content, contentHrl });
        const initRes = await submitMessage(client, taskTopicId, init);
        // index the task into the main registry (job points at its own audit-trail topic = the task topic)
        let registrySeq: string | undefined;
        if (body.registryTopicId) {
          const reg = await submitMessage(client, body.registryTopicId, buildJobPosted({ jobId: taskTopicId, skill, requester: body.requester, scope: terms.scope, auditTrailTopicId: taskTopicId, status: "agreed" }));
          registrySeq = reg.sequenceNumber;
        }
        return res.status(200).json({ taskTopicId, jobId: taskTopicId, initSeq: initRes.sequenceNumber, registrySeq, contentHrl, contentHash, init: JSON.parse(init) });
      }

      // ── /chatroom: run the REAL audit pipeline → record each stage + verdict on the task topic ──
      case "runAudit": {
        // 4 OpenAI stages (or canned fallback) → HCS stages + verdict(+capabilities) + HCS-1 report + registry.
        // Author-submitted skills pass their actual `files` (+ `skill` name); demo skills pass a `skillRef`.
        const result = await auditTaskToHcs(client, {
          taskTopicId: body.taskTopicId,
          skillRef: body.skillRef ?? body.skill,
          files: Array.isArray(body.files) && body.files.length ? body.files : undefined,
          skillName: body.skill,
          registryTopicId: body.registryTopicId,
        });
        return res.status(200).json(result);
      }

      // ── /chatroom: requester approves/disapproves → review the auditor → mint VERIFIED NFT ──
      case "finalizeTask": {
        return res.status(200).json(
          await finalizeTaskToHcs(client, {
            taskTopicId: body.taskTopicId,
            skill: body.skill,
            verdict: body.verdict,
            approve: !!body.approve,
            rating: body.rating,
            comment: body.comment,
            requester: body.requester,
            auditor: body.auditor,
            reviewTopicId: body.reviewTopicId,
            votingTopicId: body.votingTopicId,
            registryTopicId: body.registryTopicId,
            mintToAccountId: body.mintToAccountId,
          })
        );
      }

      // ── /publish: author publishes a PREMIUM (royalty-bearing) verified skill ──
      // Runs AFTER a SAFE verdict + the Arc escrow has been released on-chain. Mints the
      // VERIFIED NFT (reusing finalizeTask), creates a Hedera license collection carrying a
      // real author CustomRoyaltyFee, and records the premium skill in db/skills.json.
      case "publishPremiumSkill": {
        const skill: string = body.skill;
        const author = body.author || {}; // { hederaId?, evm, humanId }
        const royaltyPct = Math.max(1, Math.min(99, Math.round(Number(body.royaltyPct ?? 10))));
        if (body.verdict !== "SAFE") return res.status(400).json({ error: "premium publish requires a SAFE verdict" });
        if (!skill) return res.status(400).json({ error: "skill required" });
        // hederaId is OPTIONAL: with it → the Hedera CustomRoyaltyFee rail is added;
        // without it → Arc x402 split only (royalty rides the escrow developer = author wallet).
        const hederaId: string | null = /^0\.0\.\d+$/.test(String(author.hederaId || "")) ? author.hederaId : null;

        // 1) VERIFIED NFT + decision/review + main-registry update (reuse the chatroom finalizer)
        const finalize = await finalizeTaskToHcs(client, {
          taskTopicId: body.taskTopicId,
          skill,
          verdict: "SAFE",
          approve: true,
          rating: body.rating,
          comment: body.comment ?? "Premium skill — author self-published, clean audit.",
          requester: hederaId ?? (body.requester || "author"),
          auditor: body.auditor || getOperatorId(),
          reviewTopicId: body.reviewTopicId,
          votingTopicId: body.votingTopicId,
          registryTopicId: body.registryTopicId,
          mintToAccountId: hederaId ?? undefined, // else the VERIFIED NFT stays in the operator treasury
        });

        // 2) premium LICENSE collection — with the author's real CustomRoyaltyFee when a Hedera
        //    account was supplied, otherwise a plain license (royalty rides Arc x402 only).
        const license = await createLicenseCollection(client, hederaId
          ? { name: `MARS Premium · ${skill}`.slice(0, 100), symbol: "MARSP", royaltyCollectorAccountId: hederaId, numerator: royaltyPct, denominator: 100, fallbackHbar: 1 }
          : { name: `MARS Premium · ${skill}`.slice(0, 100), symbol: "MARSP" });

        // 3) persist the premium skill — author-submitted files when present, else a demo ref
        const provided: { name: string; content: string }[] | null = Array.isArray(body.files) && body.files.length ? body.files : null;
        const loaded = provided ? null : loadDemoSkill(body.skillRef ?? skill);
        const files = provided ?? (loaded?.source ? [{ name: loaded.name || skill, content: loaded.source }] : []);
        const srcForHash = provided ? provided.map((f) => f.content).join("\n") : (loaded?.source || skill);
        const fileSha256 = createHash("sha256").update(srcForHash).digest("hex");
        const record = savePremiumSkill({
          skill,
          files,
          author: { hederaId, evm: author.evm ?? null, humanId: author.humanId ?? null },
          royaltyPct,
          price: body.price ?? null,
          escrowJobId: body.escrowJobId ?? null,
          licenseTokenId: license.tokenId,
          verifiedTokenId: finalize.mint?.tokenId ?? null,
          auditId: body.auditId ?? null,
          fileSha256,
        });

        return res.status(200).json({
          ok: true,
          skill,
          premium: true,
          royaltyPct,
          verified: finalize.mint ?? null,
          license, // { tokenId, name, symbol, royalty:{ collector, numerator, denominator, fallbackHbar } }
          record,
        });
      }

      // ── HCS-11: AGENT PROFILE ─────────────────────────────────
      case "createProfile": {
        const profileTopicId = await createTopic(client, `hcs-11:profile:${body.accountId}`, submitKey);
        const profile = buildHCS11Profile(
          body.displayName,
          body.accountId,
          body.capabilities ?? [1, 2, 11, 16, 18, 20],
          body.model ?? "mars-auditor-v1",
          { bio: body.bio, creator: body.creator }
        );
        await submitMessage(client, profileTopicId, profile);
        return res.status(200).json({ profileTopicId, accountMemo: hcs11AccountMemo(profileTopicId), profile: JSON.parse(profile) });
      }

      // ── HCS-20: REPUTATION POINTS / REVIEWS ───────────────────
      case "reputationDeploy": {
        const topicId = body.topicId ?? (await createTopic(client, HCS20_MEMO, submitKey));
        const r = await submitMessage(client, topicId, buildHCS20Deploy(body.name, body.tick, body.max, body.lim));
        return res.status(200).json({ topicId, ...r });
      }
      case "reputationMint": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildHCS20Mint(body.tick, body.amt, body.to, body.m)));
      }
      case "reputationTransfer": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildHCS20Transfer(body.tick, body.amt, body.from, body.to, body.m)));
      }
      case "reputationBurn": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildHCS20Burn(body.tick, body.amt, body.from, body.m)));
      }
      case "reputationBalance": {
        return res.status(200).json(computeHCS20Balances(await readTopicMessages(body.topicId, body.limit ?? 1000)));
      }

      // ── HCS-20 VOTING (good / bad → aggregate → remove) ───────
      case "reputationVotingDeploy": {
        // one topic, two tickers: good (upvotes) + bad (downvotes)
        const topicId = body.topicId ?? (await createTopic(client, HCS20_MEMO, submitKey));
        const up = body.upTick ?? "good";
        const down = body.downTick ?? "bad";
        const max = body.max ?? "1000000";
        const lim = body.lim ?? "1000";
        await submitMessage(client, topicId, buildHCS20Deploy("MARS upvotes", up, max, lim));
        await submitMessage(client, topicId, buildHCS20Deploy("MARS downvotes", down, max, lim));
        return res.status(200).json({ topicId, upTick: up, downTick: down });
      }
      case "voteGood": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildHCS20Mint(body.upTick ?? "good", body.amt ?? "1", body.target, body.m)));
      }
      case "voteBad": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildHCS20Mint(body.downTick ?? "bad", body.amt ?? "1", body.target, body.m)));
      }
      case "removeVote": {
        // undo a vote → burn from the good or bad tick
        return res.status(200).json(await submitMessage(client, body.topicId, buildHCS20Burn(body.tick, body.amt ?? "1", body.target, body.m)));
      }
      case "reputationScore": {
        const scores = computeReputation(await readTopicMessages(body.topicId, body.limit ?? 1000), body.upTick ?? "good", body.downTick ?? "bad");
        return res.status(200).json({ scores });
      }

      // ── REVIEWS & RATINGS ─────────────────────────────────────
      case "createReviewBoard": {
        const topicId = await createTopic(client, "mars-reviews", submitKey);
        // seed the review HCS with an initial marker (op:"seed" is ignored by review aggregates)
        await submitMessage(client, topicId, JSON.stringify({ p: "mars-review", op: "seed", note: "MARS review board initialized", timestamp: new Date().toISOString() }));
        return res.status(200).json({ topicId });
      }
      case "postReview": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildReview(body)));
      }
      case "listReviews": {
        return res.status(200).json({ reviews: computeReviews(await readTopicMessages(body.topicId, body.limit ?? 1000)) });
      }

      // ── MARS AUDIT TRAIL ──────────────────────────────────────
      case "createAuditTrail": {
        const topicId = await createTopic(client, `mars-audit:${body.skillId ?? "skill"}`, submitKey);
        return res.status(200).json({ topicId });
      }
      case "auditStep": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildAuditStep(body.skillId, body.step, body.status, body.detail)));
      }
      case "auditVerdict": {
        return res.status(200).json(await submitMessage(client, body.topicId, buildAuditVerdict(body.skillId, body.verdict, body.trustScore, body.reportHrl, body.attestation)));
      }

      // ── SCHEDULE: RE-AUDIT ────────────────────────────────────
      case "scheduleReAudit": {
        return res.status(200).json(await scheduleReAudit(client, body.auditTrailTopicId, body.payload, body.memo));
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${action}".`,
          actions: [
            "createAccount / worldCheck",
            "createTopic / submitMessage / readTopic",
            "createVerifiedCollection / createLicenseCollection / mintNft / checkNft / associateToken / transferNft",
            "uploadReport / downloadReport",
            "createRegistry / registerInRegistry / readRegistry",
            "initMars / createMainRegistry / registerAgent / startJob / updateJob / readMainRegistry / logHumanVerified",
            "createSkillsRegistry / createVersionRegistry / registerSkill / registerVersion / uploadManifest",
            "trustScore",
            "createRfqBoard / rfqAnnounce / rfqPropose / rfqRespond / rfqComplete / rfqWithdraw / rfqList",
            "createFlora / floraChat / floraRead / ensureChatRoom / auditorReply / createTask / runAudit / finalizeTask / publishPremiumSkill",
            "createProfile",
            "reputationDeploy / reputationMint / reputationTransfer / reputationBurn / reputationBalance",
            "reputationVotingDeploy / voteGood / voteBad / removeVote / reputationScore",
            "createReviewBoard / postReview / listReviews",
            "createAuditTrail / auditStep / auditVerdict",
            "scheduleReAudit",
          ],
        });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  } finally {
    client?.close();
  }
}
