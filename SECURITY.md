# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. This creates a private security advisory that only you and the
maintainers can see.

Please don't open a public issue, pull request or discussion for a vulnerability before it is fixed.

Include, as far as you can:

- the Watchbell version (see [CHANGELOG.md](CHANGELOG.md)) and your OS and Node version;
- what an attacker can do, and what they need first (network access, an account and its role, a token);
- steps to reproduce, or a proof of concept;
- any idea for a fix.

Never include real tokens, passwords or personal data in a report. We will confirm the problem, work on a fix in the
private advisory, credit you in the advisory and the changelog if you want, and publish the advisory with the fixed
release.

## Supported versions

Only the latest release gets security fixes. Upgrade with `bash install.sh --upgrade` or `install.bat --upgrade` (see
[Upgrade](docs/install.md#upgrade)).

## How Watchbell protects your data

A short summary, so you can judge what counts as a vulnerability:

- It listens on `127.0.0.1` by default. LAN access is an explicit opt-in (see
  [LAN access](docs/configuration.md#lan-access)).
- The first owner can only be created with a one-time setup code that is printed in the server log and saved in the
  data folder, valid 24 hours.
- Passwords are hashed with scrypt. Owners and operators must use an authenticator app (TOTP).
- Provider tokens, webhooks and authenticator secrets are encrypted with AES-256-GCM using `OPS_ENCRYPTION_KEY` from
  `app/.env`, and are never sent to the browser.
- Console API keys are stored only as a SHA-256 hash plus a short display prefix (the first characters, so you can
  tell keys apart); the full key is shown once and never stored.
- The SQL console runs queries in a read-only transaction, as a read-only role, after a server-side check.
- Data sent to an AI provider is scrubbed: databases by alias, no emails, no tokens.

Not vulnerabilities on their own: anything that needs someone to already have shell access to the machine, read
access to `app/.env` or `app/data`, or an owner account; and the documented risks of exposing Watchbell over plain
HTTP on a network.
