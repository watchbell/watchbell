# Contributing to Watchbell

Thanks for helping. Bug reports, fixes, documentation and small features are all welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected, what happened, your OS and `node --version`, and the
  relevant log lines. Remove tokens, emails and addresses from logs first.
- **Features:** open an issue first so we can agree on the shape before you spend time on it.
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Set up a development copy

You need Node 24 and git.

```bash
git clone <your-fork-url> watchbell
cd watchbell/app
npm ci
```

Create `app/.env` for development (the [manual install steps](docs/install.md#macos-and-manual-installs) show how to
generate the secrets), then start the dev server:

```bash
npm run dev
```

It runs on http://localhost:3100 in self-host mode with a PGlite database in `app/data`. The setup code is printed in
the terminal. Developer notes (modes, scripts, folders) are in [app/README.md](app/README.md).

## Checks

Run these in `app/` before you open a pull request:

```bash
npm run typecheck
npm run lint
npx vitest run --maxWorkers=4
npm run build
```

Tests write scratch files under `WATCHBELL_TEST_TMP` if set, otherwise under `.cache/tmp` in the repository; never in
the system temp folder.

From the repository root, the installer and documentation tests run with Node's own test runner:

```bash
node --test "tests/**/*.test.mjs"
```

## Guidelines

- Keep pull requests small and focused, with a test for the change.
- No new npm dependencies without discussing them in an issue first.
- Database changes: edit `app/src/db/schema.ts`, then generate the self-host migration with
  `npm run db:generate:selfhost` and commit the generated files.
- User-facing text is plain English: short sentences, no jargon where a plain word works. If a change affects what a
  user sees or does, update the matching page in `docs/`.
- Never commit `app/.env`, `app/data`, tokens, or real emails and hostnames, also not in tests and fixtures.
- Watchbell must keep working with no cloud account: anything that needs a provider must be optional.

## License

By contributing you agree that your contribution is licensed under the MIT license of this project
([LICENSE](LICENSE)).
