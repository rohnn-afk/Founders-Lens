# API authentication

## Use the signed-in workspace

1. Open the Founder's Lens frontend at the exact origin configured for the target API. For the local profile, use http://127.0.0.1:3000. For staging, use the approved staging frontend configured in Render.
2. Sign in to the matching Clerk environment with an active, bound test account. Open the ideas list or one of your synthetic conversations. The workspace obtains a short-lived session token through Clerk's `getToken()` for its API requests, sends it as `Authorization: Bearer <JWT>`, and keeps it in memory for the request. The API checks the configured issuer, audience and authorized party, verifies the session, and resolves the existing account. Workspace access also requires current authority clearance and ownership of the requested resource.
3. Compare the workspace request's method, path, status and `X-Request-Id` with the reference. Share only the request ID and sanitized observations when investigating an issue. Keep authorization headers, tokens and exports of browser network traffic out of logs, tickets and persistent browser storage.

An invalid or expired session returns 401. An unavailable account can return 403, and an inaccessible resource typically returns 404. Refresh the session through the frontend after a 401. A 503 may indicate unavailable dependencies, clearance or a requested projection. Staging admits only the configured web origin and the read surface.

## Swagger modes

| `FL_API_DOCS` | Availability | Swagger requests |
| --- | --- | --- |
| `reference` (default) | Local and staging | Browse the reference and download the specification |
| `off` | Local and staging | Documentation routes are disabled |
| `local-health` | Loopback development API | Run the two public health probes from Swagger |

Use the signed-in workspace for protected requests. The Swagger page suppresses bearer entry and disables persistent authorization. Its assets ship with the API and use the API's existing Content Security Policy.

## Operations and environments

The default local process exposes the liveness and readiness probes. Signed local workspace admissions can add idea and conversation reads, transcript reads, idea and conversation creation, and user-message saves. The isolated local generation profile can also admit message submission, submission recovery and generation status. Its account and conversation scope is enforced at runtime. The OpenAPI document uses synthetic resource IDs.

Staging documents its health probes and five workspace reads after the staging composition starts. Memory, research, streaming, preference updates, cancel and regeneration have no mounted staging operations. The events URL returned by a locally accepted submission is reserved for streaming. The local contract harnesses exercise some additional routes, but those routes are outside the API process's supported surface.

Local idea editing requires the existing P6 read admission and a separate `FL_IDEA_EDIT=1` admission. The local fixture operator can provision `fl_idea_edit` with `prepareIdeaEditor` and explicit `prepare-local-idea-editor` confirmation, using the [edit fixture grants](../../tests/fixtures/idea-edit-grants.sql). Supply the resulting `FL_IDEA_EDIT_PASSWORD` and a fresh `FL_IDEA_EDIT_DECISION` from `signIdeaEditClearance` with `approve-local-idea-edit` confirmation. Use the verified disposable P6 database and keep credentials outside Git. The PATCH only edits an active idea's title or summary. It requires `If-Match`, returns `428` for a missing version, and returns `412` for a stale version. Hosted staging exposes the read surface.

With the standard P6 operator environment loaded, run `node tests/clerk-session-browser.test.mjs --prepare-idea-editor` with `P6_OPERATOR_CONFIRM=prepare-local-idea-editor`. Then run the same script with `--sign-idea-edit` and `P6_OPERATOR_CONFIRM=approve-local-idea-edit`. Load `.env.idea-editor.local` and `.env.idea-edit.decision.local` into the local API with `FL_IDEA_EDIT=1`.

When adding a runtime operation, register it through `documentedRoute`, add its contract in `src/documentation/specification.ts`, and mount its router with `mountDocumentedRouter` when composing a workspace. Reuse the runtime Zod contracts and update the route-coverage fixtures in `tests/openapi.test.mjs`.
