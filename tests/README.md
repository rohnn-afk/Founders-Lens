# Tests

The root [package scripts](../package.json) define the test entry points. File prefixes reflect the milestones that introduced the suites.

| Area | Where to start |
| --- | --- |
| Workspace and browser | `m03-*`, `m04-frontend-*`, `m05-frontend-*`, `clerk-session-browser.test.mjs` |
| API, identity, privacy, and persistence | `m03-workspace-*`, `m04-submission-*`, `authentication-contract.test.mjs`, `identity-authorization.test.mjs`, `suppression-*`, `database-contract.test.mjs` |
| Dispatcher, worker, and provider behavior | `m05-dispatcher*`, `m05-generation-*`, `m06-generation-context.test.mjs`, `p9-*` |
| Shells, boundaries, and deployment | `shell-smoke.test.mjs`, `import-boundaries.test.mjs`, `staging-runtime.test.mjs`, `render-deploy-staging.test.mjs`, `public-demo.integration.mjs` |

From the root, `npm test` builds the workspaces and runs the default `*.test.mjs` suites. Run a focused suite after building any workspace it imports, for example `node --test tests/m05-dispatcher.test.mjs`. `npm run test:boundaries` checks package boundaries, and `npm run test:smoke` runs the shell checks.

Live suites have separate opt-ins and target requirements. See `npm run test:database`, `npm run test:infrastructure`, the individual suite, and the [local generation runbook](../Docs/runbooks/p9-local-runtime.md). Supporting data, SQL, and Compose definitions live in [fixtures](fixtures/) and beside the tests that use them. See [CI](../.github/workflows/ci.yml) for automated jobs and the public-demo check.
