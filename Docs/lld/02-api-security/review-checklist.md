# Phase 2A — Engineering review checklist

**Status:** In Review — documentation/specification, not executed acceptance.

## Architecture
- [ ] Express ADR revision approved and applied to baseline HLD.
- [ ] Controller/use-case/repository dependency direction agreed.
- [ ] User API routes explicitly separate from signed webhooks, health and internal workers.

## Identity and security
- [ ] Clerk token and expected audience/issuer/authorized parties agreed in integration design.
- [ ] Accepted `session_token` only; no accidental machine/API-key acceptance.
- [ ] Local account eligibility enforced on every private request.
- [ ] All nested objects scoped by idea and owner.
- [ ] Foreign/unknown resource IDs produce privacy-preserving 404s.
- [ ] CORS, trusted proxy and bearer-token policy documented.

## Reliability and scale
- [ ] Idempotency scope and canonical payload rules ready for Phase 2B.
- [ ] Database/Redis/outbox transactional consistency responsibilities documented.
- [ ] Worker rechecks account/idea status at execution and before commit.
- [ ] SSE auth, reconnect and disconnect semantics assigned to Phase 2C.
- [ ] Distributed throttles distinguished from durable quota ledgers.

## Observability and release
- [ ] No secrets/private business text in logs by default.
- [ ] Error codes/test mapping agreed.
- [ ] Auth/authz abuse cases have measurable acceptance tests.
- [ ] Remaining database validation is explicitly open and does not block docs drafting.
- [ ] Retention, backup, provider data policy, budget and free-host feasibility clearly unresolved until verified.
