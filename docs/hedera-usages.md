# Where each Hedera standard is used

Local index — every line points at a file in this repo.

## hedera2

- HCS standards library (builders, computation, tally) — `lib/hedera2/hcs-standards.ts`
- HCS-20 API (deploy, mint, burn, transfer, balance) — `pages/api/hedera2/hcs/hcs20.ts`
- HCS-2 API (registry create, register, update, delete, read) — `pages/api/hedera2/hcs/hcs2.ts`
- HCS-11 API (agent profile create, read) — `pages/api/hedera2/hcs/hcs11.ts`
- HCS-16 API (Flora create, commit, reveal, discussion, tally) — `pages/api/hedera2/hcs/hcs16.ts`
- Full agent registration (HCS-11 + HCS-2 + HCS-20) — `pages/api/hedera2/hcs/register-agent.ts`
- Agent discovery via HCS-2 registry — `pages/api/hedera2/hcs/discover-agents.ts`
- Reputation management + committee selection — `lib/hedera2/agent-helpers.ts`
- Hedera account creation — `pages/api/hedera2/hedera/create-account.ts`
- HTS token creation — `pages/api/hedera2/hedera/create-token.ts`
- Topic creation — `pages/api/hedera2/hedera/create-topic.ts`
- Topic message submit — `pages/api/hedera2/hedera/submit-message.ts`
- Scheduled transactions — `pages/api/hedera2/hedera/schedule-transaction.ts`
- Demo page — `pages/hedera2/hedera.tsx`

## hederaone

- Consolidated Hedera module (HTS, HCS-1/2/11/14/16/18/20/25/26, scheduled tx) — `lib/hederaone/hedera.ts`
- Consolidated API route (~65 actions) — `pages/api/hederaone/hedera.ts`
- Streaming agent registration — `pages/api/hederaone/register-agent-stream.ts`
- Audit pipeline → HCS — `lib/hederaone/audit-task.ts`, `lib/hederaone/audit-core.mjs`
- Agent registration flow — `lib/hederaone/agents.ts`
- Demo page — `pages/hederaone/hedera.tsx`

See `docs/HEDERA.md` for the full usage guide.
