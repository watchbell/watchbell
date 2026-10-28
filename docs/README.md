# Watchbell documentation

Bahasa Indonesia: [id/README.md](id/README.md)

Watchbell is a self-hosted ops console. You run it on your own laptop or server, it watches the apps, databases and
domains you connect, and it tells you when something breaks. These pages explain how to install it and how to use
every part of it. For a quick look first, the [project README](../README.md#features) has screenshots of the main
pages.

## Start here

1. [Install](install.md): Linux and Windows installers, manual steps for macOS, upgrade and uninstall.
2. [First run](first-run.md): the setup code, the owner account, the authenticator app, and what to do when you are
   locked out.
3. [Connect providers](providers.md): which token each provider needs and the smallest permissions that work.

## Using Watchbell

- [Pages](pages.md): every page in the console and what it shows.
- [Notifications](notifications.md): Telegram, Discord, a webhook, email through your own mail server, and the
  daily email digest.
- [Auto-actions](auto-actions.md): fixes proposed for firing alerts, safe auto-run, approvals on Telegram.
- [AI](ai.md): your own AI provider keys, the gateway, API keys and the MCP server for AI agents.
- [Backups](backups.md): monthly summaries in your Google Drive, and how to back up and restore Watchbell itself.
- [SQL console](sql-console.md): read-only queries against your Supabase and Neon databases.

## Reference

- [Configuration](configuration.md): every setting in `app/.env`, including LAN access.
- [Troubleshooting](troubleshooting.md): common errors and how to fix them.
- [FAQ](faq.md)

## Other files

- [Project README](../README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)
- [Developer notes for the app](../app/README.md)

This documentation is also online at [watchbell.west-solutions.web.id/docs](https://watchbell.west-solutions.web.id/docs)
([in Bahasa Indonesia](https://watchbell.west-solutions.web.id/id/docs)).
