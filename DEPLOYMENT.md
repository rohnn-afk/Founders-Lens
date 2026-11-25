# Founder's Lens staging deployment

Work in the primary checkout. Push a focused branch and open its PR into `staging`. Require **Build and test**, **Secret and dependency checks**, and **Build and smoke-test the API image** in branch protection. Merge after review.

## Release flow

Staging push CI repeats the checks against the merge SHA. It builds the Linux amd64 API image, smoke-tests it offline, and scans its filesystem and configuration. Critical findings, unexpected highs and image secret matches block promotion. Download `api-image-scan` and `staging-api-promotion-scan` for redacted findings and exception decisions.

The 30-day exception expires **25 December 2026 at 12:32:47 UTC**. [The risk record](scripts/staging-image-risk.json) identifies the reviewed artifact, Debian OpenSSL version, five Trivy and Scout findings, and remediation. The Trivy gate permits only the two listed Debian QUIC findings while the runtime source, Node executable and system OpenSSL bytes match the review and no fix is reported. Reassess any material advisory change, and rerun Docker Scout as part of a new risk review. The release job rescans the tested image before publication. Track patched Debian and Node builds and replace the affected runtime before expiry. [OpenSSL advisories](https://openssl-library.org/news/timeline/)

After one-time enablement, the protected `staging` job packages the already-tested image with `GITHUB_TOKEN` and publishes a tag named for the full SHA. The job is serialized and checks the staging tip before publication and deployment. Download `staging-api-release` for the immutable registry reference and platform manifest. Render receives only that digest for the existing API service. The public demo and authenticated frontend are outside this promotion.

The job polls the Render deploy ID and confirms the expected image, then checks API liveness, readiness, and unauthenticated denial. A failed check fails the release job. A dropped submission response is ambiguous. Check the Render **Events** page before trying again. A successful health probe does not replace a signed-in workspace check.

## One-time setup

1. Give this repository **Manage Actions access** to the private GHCR package. Leave package visibility private. The publication job requests `packages: write`; normal CI has only read access.
2. Restrict the GitHub `staging` environment to the protected staging branch. Add the staging Render API credential as `RENDER_API_KEY` and the existing API service ID as `RENDER_STAGING_API_SERVICE_ID`. Use the narrowest Render principal your workspace supports. The job verifies the API name, URL, runtime and image repository before submitting. Never reuse the deployment credential for production.
3. Configure the existing API as image-backed for this private image repository with its pull-only credential. Keep Auto-Deploy Off and use the image CMD. Render currently checks `/health/live`. The release job separately requires `/health/ready` before marking a deployment successful. Keep the long-lived Clerk, database and public-key settings on Render. Set `FL_STAGING_DECISION_SOURCE=authority` only after the authority mailbox is populated, and remove both old decision variables in the same saved update.
4. Confirm fresh mailbox decisions and healthy API probes before setting repository variable `FL_STAGING_RELEASE_ENABLED=true`. If the merge CI finished while the switch was off, run **CI → Run workflow → staging**. The release job accepts staging pushes and dispatches and verifies the current staging tip in both cases. To retain a human gate on each deployment, configure required reviewers on the staging environment.

## Configuration ownership

Render's service environment is authoritative for each deployed service. Use its private local manifest only for preparation and recovery. Keep one operator-owned configuration source for the signer, with its own restricted credentials. GitHub's staging environment holds release credentials only. Keep shared deployment parameters such as the authority epoch identical across these boundaries and verify them before release. Never combine the API, frontend and signer secrets into a shared dotenv file.

The tracked `.env.example` is the local-development template. Historical phase fixtures are optional. Restore only the specific ignored files needed for an approved local test and keep them separate from deployment configuration.

## Renewing the staging read decisions

The existing supervised Windows signer is the current staging publisher. Use `npm.cmd run signer:check`, `npm.cmd run signer:start`, `npm.cmd run signer:status` and `npm.cmd run signer:stop` from the primary checkout. Sleep, shutdown or logoff interrupts renewal. Readiness and guarded reads fail closed as the last five-minute pair expires. Feed the sanitized status events into operator monitoring before relying on unattended uptime.

A separately approved, always-on operator host runs `node scripts/renew-staging-decisions.mjs` under a dedicated service account and a restart policy. Build its dependencies from the reviewed release using locked npm install, Prisma generation and the API build. Keep the existing private key under the operator account on an encrypted volume with a restricted ACL. A service manager may present a transient private key file to that account. Render and GitHub Actions receive only the public key. Keep database credentials in the operator service's protected configuration.

The signer uses the existing operator signer settings from `scripts/staging-sign-read.mjs`, plus `FL_CONFIRM_STAGING_RENEWAL=approve-continuous-staging-read-only` and `FL_STAGING_DECISION_WRITER_URL`. For continuous operation the operator must approve both signing flags. Use the verified direct TLS endpoints, pin both database identities and reuse the existing authority epoch, namespace and integrity key. Avoid an interactive workstation that sleeps. Use a supervised host with synchronized time and collect its logs. Confirm it can successfully publish at least once per minute under normal conditions before enabling automatic promotion.

The approved authority operator would create a dedicated non-admin `staging_decision_writer` login and apply `scripts/staging-decision-mailbox.sql` transactionally on the verified authority database. The writer receives only the mailbox privileges shown there. The API's current authority reader receives column-scoped SELECT. No application migration or existing ledger-row change is required. These hosted changes require separate authorization.

Each publication atomically replaces the complete pair with a newer pair, after fresh verified authority evidence and target checks. The signer renews every 60 seconds and retries failures every 10 seconds. Configure an alert when no `staging_decisions_published` event arrives for two minutes or repeated `staging_decision_renewal_failed` events occur. Alert on API readiness loss too. Confirm alerts and run the signer for multiple five-minute lifetimes. The API rereads the mailbox and validates both decisions, their expiry, both targets and live authority evidence on startup and guarded reads. There is no fallback on mailbox errors. Restart after expiry succeeds once a fresh pair is available and the service starts again.

## Smoke and rollback

After activation, use the designated Clerk account on the authenticated workspace and verify that the signed-in ideas request succeeds, including an empty result. Separately verify denial for an unbound account and access to foreign records using approved existing test identities and data. Do not put a user's token or account password in CI. Automated positive browser checks require a separately approved test identity and credential flow.

Check the GitHub Actions release job and the corresponding Render Events entry by deploy ID. Readiness failures can mean the mailbox is absent, the signer is late, the target evidence changed, or the API cannot reach its database. Check signer events before retrying. Keep staging release artifacts and approved digests. Prefer reverting through a PR and allowing CI to promote the verified revert. For a supervised immediate rollback, deploy only a previously approved image digest through the API service and repeat the same health and authorization checks. A digest that requires static decisions needs its own fresh authorization window.
