# Founder's Lens staging deployment

Work in the primary checkout. Push a focused branch and open its PR into `staging`. Require **Build and test**, **Secret and dependency checks**, and **Build and smoke-test the API image** in branch protection. Merge after review.

## Release flow

Staging push CI repeats the checks against the merge SHA. It builds the Linux amd64 API image, smoke-tests it offline, and scans its filesystem and configuration. Any high or critical finding or image secret match blocks promotion. Download `api-image-scan` for redacted findings. The previous one-smoke CVE acceptance does not carry forward.

The Debian OpenSSL packages in the reviewed Distroless image still trigger Trivy for [CVE-2026-107494](https://security-tracker.debian.org/tracker/CVE-2026-107494) and [CVE-2026-124709](https://security-tracker.debian.org/tracker/CVE-2026-124709). Both affect QUIC. The API listens over HTTP/TCP, and its PostgreSQL and Clerk clients use TLS over TCP. The reviewed API paths do not use QUIC, but the affected libraries remain installed. Track the upstream OpenSSL 3.5.10 fixes and update both the Debian base and Node's bundled OpenSSL when supported builds are available. Rescan before release. [OpenSSL advisories](https://openssl-library.org/news/timeline/)

After one-time enablement, the protected `staging` job packages the already-tested image with `GITHUB_TOKEN` and publishes a tag named for the full SHA. The job is serialized and checks the staging tip before publication and deployment. Download `staging-api-release` for the immutable registry reference and platform manifest. Render receives only that digest for the existing API service. The public demo and authenticated frontend are outside this promotion.

The job polls the Render deploy ID and confirms the expected image, then checks API liveness, readiness, and unauthenticated denial. A failed check fails the release job. A dropped submission response is ambiguous. Check the Render **Events** page before trying again. A successful health probe does not replace a signed-in workspace check.

## One-time setup

1. Give this repository **Manage Actions access** to the private GHCR package. Leave package visibility private. The publication job requests `packages: write`; normal CI has only read access.
2. Restrict the GitHub `staging` environment to the protected staging branch. Add the staging Render API credential as `RENDER_API_KEY` and the existing API service ID as `RENDER_STAGING_API_SERVICE_ID`. Use the narrowest Render principal your workspace supports. The job verifies the API name, URL, runtime and image repository before submitting. Never reuse the deployment credential for production.
3. After separate Render authorization, configure the existing API as image-backed for this private image repository with its pull-only credential. Keep Auto-Deploy Off, use the image CMD, and set the health check to `/health/ready`. Changing the source can trigger a deploy. Keep the long-lived Clerk, database and public-key settings on Render. Set `FL_STAGING_DECISION_SOURCE=authority` only after the authority mailbox is populated, and remove both old decision variables in the same saved update.
4. Configure and verify renewal before setting repository variable `FL_STAGING_RELEASE_ENABLED=true`. The switch ships disabled by default. To retain a human gate on each deployment, configure required reviewers on the staging environment.

## Configuration ownership

Render's service environment is authoritative for each deployed service. Use its private local manifest only for preparation and recovery. Keep one operator-owned configuration source for the signer, with its own restricted credentials. GitHub's staging environment holds release credentials only. Keep shared deployment parameters such as the authority epoch identical across these boundaries and verify them before release. Never combine the API, frontend and signer secrets into a shared dotenv file.

The tracked `.env.example` is the local-development template. Historical phase fixtures are optional. Restore only the specific ignored files needed for an approved local test and keep them separate from deployment configuration.

## Renewing the staging read decisions

A separately approved, always-on operator host runs `node scripts/renew-staging-decisions.mjs` under a dedicated service account and a restart policy. Build its dependencies from the reviewed release using locked npm install, Prisma generation and the API build. Keep the existing private key under the operator account on an encrypted volume with a restricted ACL. A service manager may present a transient private key file to that account. Render and GitHub Actions receive only the public key. Keep database credentials in the operator service's protected configuration.

The signer uses the existing operator signer settings from `scripts/staging-sign-read.mjs`, plus `FL_CONFIRM_STAGING_RENEWAL=approve-continuous-staging-read-only` and `FL_STAGING_DECISION_WRITER_URL`. For continuous operation the operator must approve both signing flags. Use the verified direct TLS endpoints, pin both database identities and reuse the existing authority epoch, namespace and integrity key. Avoid an interactive workstation that sleeps. Use a supervised host with synchronized time and collect its logs. Confirm it can successfully publish at least once per minute under normal conditions before enabling automatic promotion.

The approved authority operator would create a dedicated non-admin `staging_decision_writer` login and apply `scripts/staging-decision-mailbox.sql` transactionally on the verified authority database. The writer receives only the mailbox privileges shown there. The API's current authority reader receives column-scoped SELECT. No application migration or existing ledger-row change is required. These hosted changes require separate authorization.

Each publication atomically replaces the complete pair with a newer pair, after fresh verified authority evidence and target checks. The signer renews every 60 seconds and retries failures every 10 seconds. Configure an alert when no `staging_decisions_published` event arrives for two minutes or repeated `staging_decision_renewal_failed` events occur. Alert on API readiness loss too. Confirm alerts and run the signer for multiple five-minute lifetimes. The API rereads the mailbox and validates both decisions, their expiry, both targets and live authority evidence on startup and guarded reads. There is no fallback on mailbox errors. Restart after expiry succeeds once a fresh pair is available and the service starts again.

## Smoke and rollback

After activation, use the designated Clerk account on the authenticated workspace and verify that the signed-in ideas request succeeds, including an empty result. Separately verify denial for an unbound account and access to foreign records using approved existing test identities and data. Do not put a user's token or account password in CI. Automated positive browser checks require a separately approved test identity and credential flow.

Check the GitHub Actions release job and the corresponding Render Events entry by deploy ID. Readiness failures can mean the mailbox is absent, the signer is late, the target evidence changed, or the API cannot reach its database. Check signer events before retrying. Keep staging release artifacts and approved digests. Prefer reverting through a PR and allowing CI to promote the verified revert. For a supervised immediate rollback, deploy only a previously approved image digest through the API service and repeat the same health and authorization checks. A digest that requires static decisions needs its own fresh authorization window.
