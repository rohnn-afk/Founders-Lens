# Neon staging primary assessment and initialization

Baseline assumed for integration is local staging commit 2395a2b, which contains the Render staging gate at 9e2624c. The initial workspace milestone is read-only. See the [staging workspace API contract](../../apps/api/WORKSPACE-API.md).

## Backend audit

| Area | Status at baseline |
| --- | --- |
| Express and Clerk | Five staging GET routes behind exact-origin and method admission. The Clerk adapter verifies the bearer session and the identity service checks provider liveness and local binding. Readiness verifies both signed grants and rejects grants from different recovery runs. |
| Account and resources | Existing-only binding takes a transaction-scoped subject advisory lock and checks tombstones and pending account deletion. The resource policy and repository enforce owner scoping. Workspace transactions recheck account, idea and conversation lifecycle under row locks before reading protected fields. |
| Privacy and pagination | Authority evidence is scoped, nonce-bound, integrity checked and time limited. Signed staging decisions bind the database identities, inventory digest, epoch, key versions and use case. Signed cursors prevent cross-scope anchor reuse. |
| Persistence and migrations | Prisma 7 uses the pg adapter. The three application migrations establish the relational constraints and P9 application context. Authority lives in a separate database. There is no provider-specific schema change. |
| Submission and concurrency | The local and isolated runtime has submission, replay receipts, idempotency conflict checks and transactional locking. Staging mounts none of those write routes. |
| Background processing | Local generation, Redis/BullMQ dispatch and the worker belong to the separately gated write pipeline. The read-only API starts neither process and needs no Redis. |
| Tests | Existing contract, identity, authority and staging harnesses exercise fail-closed behavior. The database suites use explicit live flags and guarded disposable loopback targets. Hosted capacity, role delegation and login evidence are release gates. |

## Provider assessment

Neon Free advertises 1 GB of database storage and 100 CU-hours per project per month, a six-hour restore window, up to 2 CU, and ten branches. Neon also documents a 20 GB account-wide storage limit for Free. This fits an intermittent staging workspace. A continuously active 0.25 CU instance would use 100 CU-hours in 400 hours. Measure cold-start failures and readiness/health-check traffic against that budget. [Neon Free limits](https://neon.com/blog/neon-free-plan-1-gb-per-project) · [Account-wide storage](https://neon.com/blog/10x-projects-on-free-plan)

The repository configures the Render API in Oregon. Neon AWS us-west-2 is the matching region. Geographic suitability is documented. Live latency, DNS and Render egress reachability remain to be verified in the approved smoke window. Staging API pools and the operator signer default to a four-second connection-acquisition deadline. If needed, set FL_STAGING_DB_CONNECT_TIMEOUT_MS to an integer from 1500 to 5000 in the API environment and in the operator shell. The runtime identity and authority query deadlines remain separate at 1.5 seconds. Measure from Render and the operator workstation before the smoke window. [Neon regions](https://neon.com/demos/regional-latency) · [Render regions](https://render.com/docs/regions)

Use the direct endpoint for the primary roles and migration operator. The API already bounds each role pool to four connections. Keeping direct sessions preserves the existing connection startup settings and Prisma interactive transactions, account advisory locks and FOR UPDATE behavior. Neon PgBouncer uses transaction pooling, which can support transaction-scoped locks but changes session semantics and is outside this cutover. Keep a separate migration role and use the checked-in CLI config. [Neon pooling](https://neon.com/docs/connect/connection-pooling) · [Prisma 7 PostgreSQL](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)

Neon console, API and CLI roles can inherit neon_superuser. Create application logins through SQL, with no role memberships or elevated flags. On the application project verify the operator can grant EXECUTE on pg_catalog.pg_control_system() to the two runtime roles, or that each already has the required effective permission. A failure here blocks cutover. The system identifier must differ from the recorded authority system identifier regardless of endpoint name, project name, or database OID. [Neon role management](https://neon.com/docs/manage/roles)

## Authorized operator sequence

1. After approval, select a separate Neon Free application project in AWS Oregon. Select a fresh write-capable database named founders_lens_staging. Use the reviewed direct host. Preserve the Render database and retain its rollback configuration. Use the previously approved authority identity and reader configuration. Do not connect migration tooling to the authority project.
2. In a private shell, set libpq connection parameters for the application owner using the approved credential store. Use PGSSLMODE=verify-full and a trusted root CA via PGSSLROOTCERT. Record the app identity from pg_catalog.pg_control_system() and pg_catalog.pg_database, and review it against the approved endpoint and the recorded authority identity. Then run the target guard, using the same direct endpoint, database and owner planned for Prisma.

   ~~~sh
   psql -X -v expected_identity="$PRIMARY_IDENTITY" -v authority_identity="$AUTHORITY_IDENTITY" -f apps/api/scripts/verify-staging-target.sql
   ~~~

3. Put the same application owner and direct target in MIGRATION_DATABASE_URL for the shell only. For the native schema engine use sslmode=require with sslaccept=strict and the trusted system CA or sslcert pointing to the trusted CA file as needed. Verify the pinned engine rejects certificate and hostname failures on a disposable target before using operator credentials. Run the checked-in migration configuration. Resolve any unexpected history, drift, schema or TLS result before continuing.

   ~~~sh
   npm ci --include=dev
   npm run db:validate
   npm run db:generate
   npm run build --workspace=@founders-lens/api
   npm exec -- prisma migrate deploy --config prisma.config.ts
   npm exec -- prisma migrate status --config prisma.config.ts
   ~~~

   Apply only the existing application migrations. On a fresh database no existing staging content will appear. If data must be preserved, require separate approval for a consistent, application-only export and import that preserves the reviewed account bindings, lifecycle state and IDs. Never import authority, role or ACL state. Review and authorize a fixture or binding import for the designated Clerk test identities before smoke testing. The hosted API deliberately returns ACCOUNT_UNAVAILABLE for missing bindings.

4. As the reviewed application operator, create the two roles with the statements below. Enter separate SCRAM passwords through the psql password prompt and store them privately. Use the existing reviewed grant script on the verified application database.

   ~~~sql
   CREATE ROLE fl_p6_workspace LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE ROLE fl_p8_conversations LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   SET password_encryption = 'scram-sha-256';
   \password fl_p6_workspace
   \password fl_p8_conversations
   \i scripts/staging-read-grants.sql
   ~~~

   The existing read roles need UPDATE only on specific updatedAt columns to acquire row locks. These grants are effective database UPDATE privileges. Application code exposes no write route. The identity-only diagnostic has no such allowance. Use the diagnostic as the actual restricted login so operator ADMIN and SET membership differences cannot skew the result. For each runtime login, set its own private libpq credential with verify-full and run:

   ~~~sh
   psql -X -v expected_identity="$PRIMARY_IDENTITY" -v authority_identity="$AUTHORITY_IDENTITY" -f apps/api/scripts/verify-staging-primary.sql
   ~~~

5. With approval, configure Render staging API secrets. Set FL_STAGING_PRIMARY_PROVIDER=neon. Set FL_WORKSPACE_DATABASE_URL and FL_CONVERSATIONS_DATABASE_URL to the two direct application URLs using ?sslmode=verify-full and the exact application database. Keep FL_AUTHORITY_DATABASE_URL on its existing independent reader. Retain the applicable authority epoch, namespace and integrity key, the subject key used by the approved bindings, and the operator public key and cursor key. Configure the staging Clerk instance, issuer and key pair. Set the API audience to match the `aud` claim on the default Clerk session token returned by `getToken()`. Set the exact authorized party to FL_WEB_ORIGIN. The web app needs that same staging origin and the staging API origin, with FL_PUBLIC_DEMO unset for this build.
6. Immediately before the approved smoke window, run node scripts/staging-sign-read.mjs from the built checkout. Use FL_CONFIRM_STAGING_READ=approve-staging-read-only, FL_EXPECTED_PRIMARY_IDENTITY, FL_EXPECTED_AUTHORITY_IDENTITY, FL_OPERATOR_PRIMARY_READ_URL and FL_OPERATOR_AUTHORITY_READ_URL with strict TLS, FL_OPERATOR_PRIVATE_KEY_FILE, FL_STAGING_DECISION_OUTPUT and the existing FL_AUTHORITY_EPOCH, FL_AUTHORITY_NAMESPACE and FL_AUTHORITY_INTEGRITY_KEY. Use a new private output path. Supply both generated decisions to the Render API as FL_STAGING_IDEAS_DECISION and FL_STAGING_TRANSCRIPT_DECISION. They expire after five minutes. Accepting requests over a longer period requires a separately reviewed renewal mechanism. Database durability and access clearance have distinct lifetimes.
7. Deploy only the approved checked commit. During the signed window verify /health/ready, the exact allowed browser origin, 401 for absent or invalid credentials, 403 for a valid unbound identity, each authorized workspace read with a bound fixture, and 404 for the other fixture's idea, conversation and transcript. Verify cursor replay, malformed input denial and write-route denial. Check cold and warm timing with approved read-only traffic. After expiration verify readiness and protected operations fail closed. For rollback restore the prior primary configuration only with fresh decisions bound to that primary.

These steps require approval for project creation, migrations, role grants, fixture setup, credentials, and deployment. Hosted tests use approved read-only targets. Disposable local PostgreSQL and Redis are the targets for automated write tests.
