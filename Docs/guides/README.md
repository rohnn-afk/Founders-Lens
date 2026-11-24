# Project map

## Follow a request

**Hosted staging read.** A founder signs in through Clerk. The [web workspace](../../apps/web/README.md) sends a bearer session token to the [API](../../apps/api/README.md). The staging composition authenticates the session, resolves an existing account, checks the independent suppression authority and signed read decisions, and reads the founder's data from PostgreSQL. See the [five staging workspace routes](../../apps/api/WORKSPACE-API.md).

**Local generation.** The gated API accepts a submission and records the message and generation work in PostgreSQL. The [dispatcher](../../apps/dispatcher/README.md) reads the outbox and publishes to BullMQ on Redis. The [worker](../../apps/worker/README.md) claims the job, loads permitted context, calls the configured adapter, and persists the result and accounting. The [local generation runbook](../runbooks/p9-local-runtime.md) describes the separate launcher, fixture and permissions.

**Public demo.** The web build can use its demo mode with `FL_PUBLIC_DEMO=true`. The [web guide](../../apps/web/README.md) points to the demo implementation.

## Choose the source of truth

| Question | Start with |
| --- | --- |
| What should the product do? | [SRS](../requirements/SRS.md) for approved behavior and acceptance criteria. [PRD](../requirements/PRD.md) for goals and scope. Apply explicit owner decisions and controlled amendments where they supersede earlier wording. |
| Why is the system built this way? | [HLD](../architecture/HLD.md), active [Express ADR](../architecture/adr/013-express-typescript-api.md), and the [design register](../README.md) for detailed designs and approval history. |
| Which endpoints are served in this checkout? | [Express entry point](../../apps/api/src/main.ts), the selected composition and its mounted routers and Zod schemas. [Workspace API](../../apps/api/WORKSPACE-API.md) describes the staging read baseline. [OpenAPI](../lld/02-api-security/openapi.yaml) describes the broader design surface. |
| What determines the database structure? | [Prisma schema, migrations, and grants](../../apps/api/prisma/README.md) for executable database artifacts. The [database design index](../lld/01-database/README.md) explains the intended model and invariants. |
| What runs locally? | [Root package scripts](../../package.json), [Compose](../../compose.yaml), and the environment parsers linked from each module guide. Use [.env.example](../../.env.example) for local conventions. |
| What gets released to staging? | [CI workflow](../../.github/workflows/ci.yml), [Render Blueprint](../../render.yaml), and [release procedure](../../DEPLOYMENT.md). Check the deployed revision and its smoke evidence before treating checkout behavior as live behavior. |
| What has been verified? | [Tests](../../tests/README.md) for executable coverage and the relevant CI or run output for results. Approval manifests record reviewed document revisions. |

When design and implementation differ, record the discrepancy with the relevant requirement, code path, environment, and evidence. The [M00 matrix](../planning/m00-code-to-contract-matrix.md) is an early planning snapshot from before the application directories existed.

## Repository layout

- `apps/` contains the four npm workspaces. Each owns its source and dependencies.
- `Docs/guides/` contains onboarding and navigation. `Docs/runbooks/` contains operating procedures.
- `Docs/requirements/`, `Docs/architecture/`, `Docs/lld/`, and `Docs/planning/` contain design and planning records. Approval manifests preserve historical paths and fingerprints.
- `scripts/` contains cross-workspace tooling and operator commands. `tests/` contains cross-module tests and fixtures.
- Root manifests and `.github/workflows/` define workspace tooling, infrastructure, and release automation.

Keep executable details in their owning code or configuration. Update the nearest guide when a module's entry point, behavior, or operating procedure changes.
