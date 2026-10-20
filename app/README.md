# Watchbell app: developer notes

This folder is the Watchbell web app: a Next.js 16 (App Router) project with React 19, Drizzle ORM and Tailwind CSS.
For installing and using Watchbell, see the [project README](../README.md) and the [docs](../docs/README.md). These
notes are for working on the code.

## Requirements

- Node 24 (`engines` is `24.x`) and npm.
- An `app/.env` with at least `WATCHBELL_MODE=selfhost`, `OPS_ENCRYPTION_KEY`, `SITE_URL`, `COLLECTOR_SECRET` and
  `CRON_SECRET`. The installer writes one; [.env.example](.env.example) explains every key, and
  [Configuration](../docs/configuration.md) has the reference.

## Modes

`WATCHBELL_MODE` decides how the app runs (`src/lib/mode.ts`):

| Mode | Database | Sign-in | Scheduler |
|---|---|---|---|
| `selfhost` | PGlite in `WATCHBELL_DATA_DIR` (`DATABASE_URL=pglite:`) | Local accounts (`src/lib/local-auth`), first-run `/setup` | Built in (`src/lib/scheduler`), plus Telegram polling |
| `cloud` (unset) | Supabase Postgres (`DATABASE_URL`) | Supabase Auth | External: cron-job.org, Upstash QStash, Vercel Cron |
| `demo` | One in-memory PGlite per visitor, seeded with made-up data | Signed demo cookie | None; outbound requests are blocked |

Self-host is the edition's default and the one the installers set up. The server's start-up hook
(`src/instrumentation.ts`) opens the database, prints the setup code while there is no owner, and starts the scheduler
and the Telegram poller.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 3100 |
| `npm run build` | Production build |
| `npm run start:selfhost` | Starts the built app in self-host mode (`scripts/start-selfhost.mjs`: reads `app/.env`, PGlite defaults, `HOST`/`PORT`, clean shutdown) |
| `npm run stop:selfhost` | Asks a running self-host server to stop cleanly (writes `<WATCHBELL_DATA_DIR>/stop-request`, waits up to 30 s; `-- --timeout <s>` to change) |
| `npm run start` | Plain `next start` on port 3100, without the self-host defaults; use `start:selfhost` instead |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, all tests once. Run the full suite as `npx vitest run --maxWorkers=4`: uncapped workers can run a laptop out of memory |
| `npm run test:watch` | Vitest in watch mode |
| `npm run reset-login -- <email>` | Self-host account recovery: a temporary password, authenticator removed (Watchbell must be stopped) |
| `npm run db:generate:selfhost` | Generates the self-host migration in `drizzle-selfhost/` from `src/db/schema.ts` |
| `npm run db:generate` | Generates a cloud migration in `drizzle/` |
| `npm run bootstrap:owner` | Cloud only: creates the first owner in Supabase Auth |

## Tests

```bash
npx vitest run --maxWorkers=4
npx vitest run src/lib/sql --maxWorkers=4     # one folder
```

Cap the workers (`--maxWorkers=4`): the suite starts many PGlite instances and the default worker count can run a
laptop out of memory. Tests write scratch files under `WATCHBELL_TEST_TMP`, or `.cache/tmp` at the repository root
when it isn't set; never in the system temp folder. Tests make no real network calls (MSW and fakes).

Before a pull request: `npm run typecheck`, `npm run lint`, the tests, and `npm run build`.

## Layout

| Path | What is there |
|---|---|
| `src/app` | Routes. `(console)` holds the signed-in pages; `api/` the HTTP API (`api/v1` for API keys, `api/ping` for heartbeats, `api/health`) |
| `src/components` | Shared UI: the kit (cards, tables, banners), the shell and menu, dialogs |
| `src/lib` | The core: providers, collector, alerts, notifications, backups, SQL console, local auth, scheduler |
| `src/private` | The AI gateway, API keys, MCP server and auto-actions, registered into the core through `src/private/registry.ts` |
| `src/db` | Drizzle schema (`schema.ts`, Postgres schema `ops`), the PGlite opener and its folder lock |
| `drizzle-selfhost` | The self-host migrations, applied automatically when the app starts |
| `drizzle` | The cloud migrations |
| `scripts` | `start-selfhost.mjs`, `reset-login.mts`, `bootstrap-owner.mts` |
| `test` | Test helpers |

## Conventions

- All database access goes through Drizzle and `db()` from `src/db/client.ts`; call `ready()` first outside the app.
- Every secret at rest is sealed with `OPS_ENCRYPTION_KEY` (`src/lib/crypto.ts`); nothing secret is sent to the
  browser or written to a log.
- User-facing text is plain English; messages sent to Telegram, Discord and email also have Bahasa Indonesia.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for the rest.
