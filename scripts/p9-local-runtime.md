# P9 local deterministic dispatcher and worker

## Environment boundaries

| Environment | Authentication and data | Generation |
| --- | --- | --- |
| Local offline acceptance | Designated Clerk Development account, dedicated loopback PostgreSQL primary and authority, authenticated local Redis | Deterministic worker with one pinned conversation and synthetic prompt |
| Automated integration | Disposable PostgreSQL and Redis, controlled test principals and applied migrations | Deterministic provider and failure injection |
| Hosted staging | Clerk account binding, restricted Neon roles, independent authority and release gates | Read-only workspace |
| Production | Separate identities and infrastructure, reviewed deployment and capability approvals | Provider activation requires separate authorization |

The one-shot scope used for acceptance and provider experiments is too narrow
for routine offline feature development. A durable local developer profile
should retain ownership and local authority checks, use dedicated loopback
stores, and refuse paid-provider or hosted configuration. The offline acceptance
launcher consolidates the existing signing steps without changing grant expiry.

## Designated Clerk offline acceptance

Build API, dispatcher and worker, then create the dedicated loopback stores
once with `node scripts/p9-cedar-bootstrap.mjs --offline`. The command refuses
existing resources. An interrupted run before coverage initialization can
resume with `--offline --resume` against the same verified Docker project.

Start the Clerk-enabled web at `http://127.0.0.1:3000`. Run
`tests/clerk-session-browser.test.mjs --offline-bind-account` with the ignored
Clerk development manifest and exact loopback authorized party. Sign in in the
Edge window. The restricted provisioning role closes after binding.

Set the existing `P6_OPERATOR_PRIVATE_KEY_FILE` and `P6_OPERATOR_PUBLIC_KEY_FILE`
paths in the operator shell. With port 3001 clear, launch:

```powershell
node scripts/p9-offline-acceptance.mjs workspace
```

Create and edit a synthetic idea, then create an empty conversation. Copy the
conversation ID from the browser URL. Stop the launcher and run:

```powershell
node scripts/p9-offline-acceptance.mjs generation <conversation-id>
```

Reload the conversation, submit the printed synthetic prompt exactly, and
reload after completion to verify history. The operator keys and database
admin credentials stay outside the API and background processes. Ctrl+C stops
the launcher. Stop the three `fl-p9-offline-acceptance` project containers to
retain state. A reset deletes only that project's volumes and its matching
ignored manifests after verifying their identities and reviewing data retention.

## Runtime configuration

Run the launcher from the repository root after building the API, dispatcher,
and worker. Feed it a dedicated ignored environment file. Keep the API process
on its separate local P9 submit/status configuration.

```powershell
npm.cmd run build --workspace=@founders-lens/api --workspace=@founders-lens/dispatcher --workspace=@founders-lens/worker
node --env-file=.env.p9-runtime.local scripts/p9-local-runtime.mjs
```

Verify the env file is ignored before placing any credentials in it
(`git check-ignore .env.p9-runtime.local`). Use another existing ignored path
if needed. The launcher starts the dispatcher and worker and exits on console
interrupt or signed permission expiry. It never provisions data or renews a
decision.

Required settings:

- `FL_P9_LOCAL_RUNTIME=deterministic` and `P9_GEMINI_MODEL=gemini-3.1-flash-lite`.
  Leave the Gemini API key unset.
- `FL_P9_DISPATCH_DATABASE_URL`, `FL_P9_VERIFIER_DATABASE_URL`, and
  `FL_P9_WORKER_DATABASE_URL` point to the exact same approved primary at
  `127.0.0.1:55437/founders_lens_p6_local` as `fl_p9_dispatch`,
  `fl_p9_context_verifier`, and `fl_p9_worker`, respectively. Claim and
  context reads use the same PostgreSQL login. The verifier uses its own login.
- `FL_P9_AUTHORITY_DATABASE_URL` points to the independent ledger at
  `127.0.0.1:55436/suppression_proof` as `ledger_reader`.
- `FL_P6_AUTHORITY_EPOCH`, `FL_P6_AUTHORITY_NAMESPACE`,
  `FL_P6_INTEGRITY_KEY`, and `FL_P9_RETAINED_VERSIONS` match authenticated
  authority coverage. The launcher requires version numbers and the authority
  integrity key. Subject-key HMAC material stays outside this configuration.
- `FL_P6_OPERATOR_PUBLIC_KEY` contains the pinned Ed25519 SPKI DER public key
  encoded as base64. `FL_P9_DISPATCH_DECISION` and `FL_P9_EXECUTE_DECISION`
  contain separate signed envelopes for the same primary, authority and
  recovery run. Keep the signing private key outside the process.
- `FL_P9_REDIS_URL` points to the password-protected local Redis at
  `127.0.0.1:56381/0`. Use `FL_P9_REDIS_RUN` as a fresh UUIDv4 for a fresh
  run or retain it to restart an existing run. It namespaces the queue.
- `FL_P9_SYNTHETIC_ACCOUNT`, `FL_P9_SYNTHETIC_CONVERSATION`, and
  `FL_P9_SYNTHETIC_TEXT_SHA256` match the independently approved, isolated
  synthetic fixture and the API admission configuration. A fresh conversation
  is required for the single-turn provider guard. Use no existing founder
  conversation.

On a separately approved primary, apply the existing P9 migrations and
`scripts/p9-local-runtime-grants.sql` using an operator connection after
creating the four dedicated roles and granting CONNECT. The launcher performs
no DDL. The API uses the separate `fl_p9_submit` role and signed submit/status
decisions. Keep the P8 conversation read permission configured so the browser
can discover Send on the approved conversation. The disposable test applies the
same runtime grants and uses
the alternate primary/authority target pinning selected by
`FL_P9_DISPOSABLE=1`.

Run the disposable proof with `node tests/m05-local-generation.test.mjs --live`.
The standalone adapter in this command records a clearly labeled offline
observation. No external model is used.

## Local Clerk clock check

The Express Clerk adapter verifies token timestamps with zero clock skew. If
Clerk shows an active session but a fresh bearer receives HTTP 401, check the
workstation's clock before changing authentication settings. On Windows, use
`w32tm /stripchart /computer:time.windows.com /samples:3 /dataonly` and sync in
**Settings → Time & language → Date & time** if needed. Reload the workspace
after syncing. An expired signed local admission is a separate failure that
returns HTTP 503 after token verification. Refresh it through the existing local
operator procedure.

## Recovery proofs

Run these sequentially because they use the same disposable local ports.

```powershell
node tests/m05-local-generation.test.mjs --live --p9-authority-loss
node tests/m05-local-generation.test.mjs --live --p9-crash
```

The first withdraws live authority access before finalization. The second
kills the subprocess after it enters the offline provider callback, then
restarts the same runtime and namespace.

## Gemini mode after separate authorization

Set `FL_P9_ISOLATED=1` in both API and worker environments. This separately
approved profile pins the primary to `127.0.0.1:55435/founders_lens_p9_local`
and its independent authority to `127.0.0.1:55438/suppression_proof`. It
requires its own authenticated genesis in the ignored files
`.env.p9-primary.runtime.local` and `.env.p9-primary.operator.local`.
Keep the existing P6–P8 target separate.

On that approved target, set `P6_OPERATOR_CONFIRM=approve-p9-isolated-runtime`
and the existing `P6_OPERATOR_PRIVATE_KEY_FILE` and
`P6_OPERATOR_PUBLIC_KEY_FILE` variables to operator-owned key paths. Then run:

```powershell
node --test-name-pattern '^P9 operator signs isolated runtime permissions$' tests/clerk-session-browser.test.mjs --p9-sign-isolated
```

This verifies exact genesis, retained keys and authority inventory, then
creates `.env.p9.decisions.local` with six five-minute permissions sharing
one recovery run. The API needs workspace read, conversation read, submit and
status. The dispatcher and worker need dispatch and execute. Both need the
pinned public key. The signer refuses to overwrite an existing file. Keep the
private key outside both runtimes.

Use a fresh dedicated synthetic account and conversation on an approved
local target with the same verified controls above. Keep the API configuration
separate. Only the worker's ignored env file should contain `P9_GEMINI_API_KEY`.
After owner authorization, set `FL_P9_LOCAL_RUNTIME=gemini`,
`FL_P9_GEMINI_CONFIRM=approve-one-synthetic-invocation`, and
`FL_P9_MAX_ADMISSIONS=1`. Set the same single admission cap in the API env.
Use the pinned model shown above and omit `FL_P9_DISPOSABLE`.

The API and worker must use the same explicit tariff and budget settings
(`FL_P9_PRICE_VERSION`, `FL_P9_MAX_MICROS_PER_MILLION_TOKENS`,
`FL_P9_BUDGET_MICROS`, `FL_P9_ACCOUNT_TOKEN_BUDGET`, and
`FL_P9_REQUESTS_PER_MINUTE`). The worker requires the full configured
reservation and refuses to write another invocation marker for an account
that already has one, including one with an unknown provider outcome.
Use a maximum rate of at least 1,500,000 USD micros per million tokens for
the current paid text tariff. At that rate the 4,608-token reservation needs
at least 6,912 USD micros of configured budget.
Do not clear that marker to retry an uncertain request.

## Groq mode after separate authorization

Use an unused synthetic account and empty conversation on the verified isolated
target. The invocation allowance is account-scoped. Keep previous attempts and
reservations intact. Load the approved account, conversation, and prompt hash in
both processes. Use split five-minute decisions and a fresh Redis run.

The historical Cedar acceptance profile uses `FL_P9_CEDAR_ACCEPTANCE=1` with
primary, authority and Redis ports 55441, 55442 and 56383. The recheck profile
uses `FL_P9_CEDAR_ACCEPTANCE=2` with ports 55443, 55444 and 56384 and separate
credentials. The recheck produced the persisted Groq answer that settled 804
provider-reported tokens. Its account has consumed its allowance.

Set the same values in the API and worker shells, overriding Gemini defaults:

```powershell
$env:FL_P9_PROVIDER = 'groq'
$env:P9_GROQ_MODEL = 'openai/gpt-oss-20b'
$env:FL_P9_ISOLATED = '1'
$env:FL_P9_PRICE_VERSION = 'v1:groq-gpt-oss-20b'
$env:FL_P9_MAX_MICROS_PER_MILLION_TOKENS = '300000'
$env:FL_P9_BUDGET_MICROS = '1575'
$env:FL_P9_ACCOUNT_TOKEN_BUDGET = '5248'
$env:FL_P9_MAX_ADMISSIONS = '1'
$env:FL_P9_REQUESTS_PER_MINUTE = '1'
```

In the worker shell only, remove inherited `GROQ_API_KEY` and
`P9_GEMINI_API_KEY`. Load a worker configuration with the existing restricted
database, authority and Redis credentials and no Gemini key. The launcher
reads `GROQ_API_KEY` directly from the ignored `.env.p9-groq-worker.local`
file. Do not pass that file to the API or web app. Set
`FL_P9_LOCAL_RUNTIME=groq` and
`FL_P9_GROQ_CONFIRM=approve-one-synthetic-invocation` only after explicit
authorization.

Groq reserves 5,248 tokens: up to 4,096 prompt bytes with a 128-token
chat-framing allowance, plus 1,024 completion tokens including reasoning. The minimum paid-tariff
budget rounds conservatively using the higher output rate for every reserved
token. The ledger settles against the provider-reported total. Missing or
inconsistent usage leaves the reservation unresolved. Provider rejections,
timeouts, and transport failures never trigger a second request.

Mocked Groq integration proofs use disposable primary, authority and Redis
ports 55439, 55440 and 56382, separate from the persistent local targets:

```powershell
node tests/m05-local-generation.test.mjs --live --p9-groq
node tests/m05-local-generation.test.mjs --live --p9-groq-failure
```
