# Web app

This Next.js workspace owns browser routes, Clerk session integration, and the founder workspace UI.

| Area | Start with |
| --- | --- |
| Public entry and demo | [Home](app/page.tsx), [demo](app/demo.tsx), and [build mode](next.config.ts) |
| Authenticated routes | [Workspace layout](app/app/layout.tsx), [sign-in route](app/sign-in/), and [request proxy](proxy.ts) |
| Ideas, conversations, and thinking UI | [App Router pages](app/app/ideas/) and [workspace feature](features/workspace/) |
| API calls and browser contracts | [Endpoints](features/workspace/endpoints.ts), [contracts](features/workspace/contracts.ts), and [workspace provider](features/workspace/workspace-provider.tsx) |
| Submission recovery and generation status | [Recovery storage](features/workspace/submission-recovery-storage.ts) and [generation controller](features/workspace/generation-controller.ts) |

Start with `npm run dev:web` from the repository root. Set `FL_PUBLIC_DEMO=true` before starting or building to select demo mode. The authenticated workspace uses the API capabilities exposed by the selected environment.

Use the [test guide](../../tests/README.md) for browser and frontend coverage and the [frontend design review](../../Docs/lld/06-frontend/frontend-integration-review.md) for approved journeys and design decisions.
