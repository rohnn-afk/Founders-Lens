# Railway staging

This milestone supports a short read-only workspace smoke test. Use an isolated environment named `staging`, a dedicated Clerk instance and synthetic data. Hosted generation is deferred.

| Service | Build from repository root | Start and health |
| --- | --- | --- |
| web | `node scripts/next.mjs build --webpack` | `node scripts/next.mjs start --hostname :: --port "$PORT"`. Public HTTPS, `/health/ready` |
| api | `npm run db:generate && npm run build --workspace=@founders-lens/api` | `node apps/api/dist/main.js`. Public HTTPS, `/health/ready` |
| primary-postgres | Railway PostgreSQL | Private service, dedicated volume |
| privacy-postgres | Railway PostgreSQL | Private service, independent cluster and volume |

Leave Redis, dispatcher, and worker unprovisioned for the first smoke test. Keep provider keys out of all four services.

Use Node 24.22.3 and npm 11.19.1. Both HTTP services expose `/health/live`. Railway uses readiness during rollout. Arrange ongoing monitoring separately.

## Variables

- Web build and runtime: `NEXT_PUBLIC_FL_WEB_ORIGIN`, `NEXT_PUBLIC_FL_API_ORIGIN`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Use HTTPS origins without paths or trailing slashes. Web runtime also needs `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES` (JSON array of the web origin), and `FL_INTERNAL_API_ORIGIN=http://api.railway.internal:3001` if API `PORT=3001`.
- API runtime: `NODE_ENV=production`, `FL_DEPLOYMENT=staging`, `PORT`, `FL_WEB_ORIGIN`, `CLERK_INSTANCE_ID`, `CLERK_ISSUER`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES` (exact web origin), and `CLERK_AUDIENCE` (nonempty JSON array matching the configured Clerk tokens). Both services use the same dedicated staging Clerk instance.
- API PostgreSQL: `FL_WORKSPACE_DATABASE_URL` and `FL_CONVERSATIONS_DATABASE_URL` point to the same primary using `fl_p6_workspace` and `fl_p8_conversations`, respectively. `FL_AUTHORITY_DATABASE_URL` points to the independent authority using `ledger_reader`. Use `postgresql://` URLs on `.railway.internal` with percent-encoded credential components. Keep administrative logins out of application services.
- API clearance: `FL_SUBJECT_KEY_V1`, `FL_CURSOR_KEY`, `FL_AUTHORITY_INTEGRITY_KEY` (separate 64-hex-character keys), `FL_AUTHORITY_EPOCH`, `FL_AUTHORITY_NAMESPACE`, `FL_OPERATOR_PUBLIC_KEY` (base64 Ed25519 SPKI DER), `FL_STAGING_IDEAS_DECISION`, and `FL_STAGING_TRANSCRIPT_DECISION`. Keep the private signing key on the operator workstation. Provider keys are forbidden in the API. The eventual Groq key belongs in the worker alone.

## First smoke deployment

1. Review the staging plan from [.railway/railway.ts](.railway/railway.ts). Attach the approved revision to web and API. Reserve their HTTPS domains and keep data services private. Confirm the plan contains exactly web, API, and the two PostgreSQL services.
2. Create the `founders_lens_staging` database and both login roles with separate credentials. From a one-off operator connection to the verified primary, set `MIGRATION_DATABASE_URL` to a dedicated migrator credential and run `node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts`. Apply [the staging read grants](scripts/staging-read-grants.sql) as an operator with authority over the database and schema objects. Independently initialize the authority ledger as described below. Bind a staging Clerk test account via an approved operator procedure before attempting the signed-in smoke check.
3. Build web with its public variables and configure API runtime values. Once the API build is ready for rollout, issue fresh decisions on a trusted operator workstation with private network access. Build the API there, then run `node scripts/staging-sign-read.mjs` with `FL_CONFIRM_STAGING_READ=approve-staging-read-only`, the verified `FL_EXPECTED_PRIMARY_IDENTITY` and `FL_EXPECTED_AUTHORITY_IDENTITY`, `FL_OPERATOR_PRIMARY_READ_URL`, `FL_OPERATOR_AUTHORITY_READ_URL`, the authority epoch, namespace and integrity settings above, `FL_OPERATOR_PRIVATE_KEY_FILE`, and `FL_STAGING_DECISION_OUTPUT` pointing to a new private file outside the checkout. Import the two decision values into API variables and start the rollout within their five-minute lifetime.
4. Verify both readiness endpoints return 200. Confirm unauthenticated API requests return 401, denied origins fail CORS, and workspace POSTs return 404. Sign in with the approved account and open its ideas and saved conversation. Check that expired evidence causes readiness and reads to fail closed.

### Authority initialization gate

On the fresh private authority cluster, create a dedicated `suppression_proof` database. Review the [authority bootstrap fixture](tests/fixtures/suppression-ledger-bootstrap.sql) against that target before applying it. It creates the ledger schema, separate roles and an empty inventory. The owner must verify the cluster identity and authenticate the empty history before sealing initial coverage for retained subject-key version `[1]`. Keep the challenge derivation secret and writer credentials outside web and API. The reader also needs `EXECUTE` on `pg_catalog.pg_control_system()` to attest the actual cluster. A database with an empty inventory and no authenticated coverage remains unready. The staging signer uses the real ledger verifier to check the namespace, epoch, retained versions and inventory before issuing either decision.

Continuous deployment still requires a reviewed hosted bootstrap and account-binding procedure, and operator-controlled renewal that can keep ahead of deploy and decision expiry. Hosted writes and generation require distinct signed admission and execution permissions, explicit account eligibility and permission to send context to Groq, and separately deployed dispatcher and worker credentials. The local synthetic allowlist and local purpose grants cannot substitute for those controls.

Railway references: [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code/reference), [private networking](https://docs.railway.com/networking/private-networking), and [health checks](https://docs.railway.com/deployments/healthchecks).
