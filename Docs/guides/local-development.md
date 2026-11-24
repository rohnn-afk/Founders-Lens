# Local development

Use the primary checkout on `integration/consolidated`. Run commands from the repository root. In Windows PowerShell, use `npm.cmd` if execution policy blocks the npm shim.

```sh
npm ci
npm run check-toolchain
npm run db:generate
```

The [root manifest](../../package.json) pins Node and npm. Prisma generation uses the checked-in [CLI configuration](../../prisma.config.ts) and works without database credentials.

## Start the shells

Run these commands in separate terminals.

```sh
npm run dev:api
npm run dev:web
```

Open `http://127.0.0.1:3000`. The API defaults to `http://127.0.0.1:3001`. The HTTP shells can start before authenticated workspace dependencies are configured. Use the [web guide](../../apps/web/README.md) for demo mode, and the [.env.example configuration reference](../../.env.example) for local workspace settings. Store credentials in ignored files.

For PostgreSQL and Redis, see [Compose](../../compose.yaml) and the infrastructure settings in [.env.example](../../.env.example). For generation, use the [P9 runbook](../runbooks/p9-local-runtime.md) with its dedicated roles and signed permissions. The dispatcher and worker dev scripts start lifecycle shells.

## Validate a change

```sh
npm run lint
npm run typecheck
npm test
```

See the [test guide](../../tests/README.md) for suite selection and live-test prerequisites.
