# Staging workspace API

Contract at staging baseline 2395a2b. All paths use the /api/v1 prefix. Health probes are outside this prefix. The workspace has five GET endpoints.

Send exactly one Authorization header with a Clerk session bearer JWT. The server verifies the Clerk instance, audience, authorized party and live session, then resolves an existing local account. An account needs to be active, bound to that Clerk instance and subject, and cleared by the independent authority. Hosted requests never create or relink an account. Browser callers use the exact configured HTTPS origin. Successful preflight returns 204 for GET with the authorization header.

| Method and path | Input | HTTP 200 response |
| --- | --- | --- |
| GET /ideas | Optional limit and cursor | Page of Idea |
| GET /ideas/:ideaId | UUID, empty query | Idea |
| GET /ideas/:ideaId/conversations | UUID, optional limit and cursor | Page of Conversation |
| GET /conversations/:conversationId | UUID, empty query | Conversation |
| GET /conversations/:conversationId/messages | UUID, optional limit, cursor and assistantResponseVersion | Page of Message |

Requests are bodyless. Query keys are strict. Pagination uses a decimal limit of 1–100, default 25. Supply the opaque nextCursor while hasMore is true. Idea and conversation lists order by updatedAt descending then UUID descending. Idea and conversation cursors are bound to the account and collection. History is ordered by logical turn and slot, from oldest to newest. History cursors bind the account, idea, conversation and limit. Cursors are signed. Changes to ordering fields between requests can move items between pages.

- Page is an object with items (array) and page (object with hasMore boolean and nextCursor string or null).
- Idea has UUID id, title, optional nullable summary, status, positive integer version, createdAt and updatedAt. The ideas collection includes ACTIVE and ARCHIVED rows. The hosted detail route admits ACTIVE rows.
- Conversation has UUID id and ideaId, optional nullable title, status (ACTIVE or ARCHIVED), boolean proactiveResearch, positive integer version and optional createdAt. Hosted conversation and transcript routes require an ACTIVE parent and return ACTIVE conversations.
- Message has UUID id and conversationId, positive integer sequence, role (USER or ASSISTANT), string content and createdAt. assistantResponseVersion accepts 1 or 2. Omission or 1 requests the text projection. Version 2 returns 503 PROJECTION_UNAVAILABLE.
- Timestamps are ISO 8601 strings. Private responses use Cache-Control no-store and carry X-Request-Id.

Handled errors return an error object with code, message, requestId and retryable. Expect 400 VALIDATION_ERROR for invalid input, 401 UNAUTHENTICATED for rejected credentials, 403 ACCOUNT_UNAVAILABLE for unavailable bindings, 404 RESOURCE_NOT_FOUND for missing or inaccessible resources, 503 DEPENDENCY_UNAVAILABLE or PROJECTION_UNAVAILABLE for unavailable reads and 500 INTERNAL_ERROR for unhandled failures. Middleware can return an empty 403 for an unapproved browser origin or empty 404 for an unsupported path, method or preflight. Ownership always comes from the resolved principal. Foreign and missing resource IDs are indistinguishable.

Hosted staging exposes no account creation, preferences, submission, mutation or generation routes. Local and isolated test compositions have separate capabilities. The Zod schemas in src/workspace/contracts.ts and src/submission/contracts.ts define field constraints.
