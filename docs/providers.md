# Connect providers

Bahasa Indonesia: [id/providers.md](id/providers.md)

Watchbell reads your providers with tokens you create in each provider's dashboard. All of them are optional: connect
only what you use.

- [How connecting works](#how-connecting-works)
- [Vercel](#vercel)
- [Supabase](#supabase)
- [Neon](#neon)
- [Firebase](#firebase)
- [Turso](#turso)
- [Upstash](#upstash)
- [Cloudflare](#cloudflare)
- [GitHub (read-only)](#github-read-only)
- [GitHub (PR write)](#github-pr-write)
- [When a token is missing a permission](#when-a-token-is-missing-a-permission)

## How connecting works

1. In Watchbell open **Connections** (owner only). Providers are shown as tiles grouped by the section they belong
   to (Hosting, Database, DevOps; Google Drive backups sit under Manage). Each tile says whether the provider is
   connected, how many accounts it has and whether one needs attention. Click a tile to open its drawer. A link to
   `/connections?provider=<name>` (for example `?provider=neon`) opens that drawer directly.
2. In the drawer, **Create one** opens the provider's token page (the links below), and **It needs** lists the smallest
   permissions. Create the token there.
3. Paste the token, give the account a name (shown next to everything that comes from it) and press
   **Test connection** to check it without saving anything. **Save** always runs the same test first and stores the
   token only when it works. A token with more access than Watchbell needs is accepted. Watchbell can tell only once
   an action has used the token's write access; from then on the account's **Access** line says "Actions on".
4. Press **Sync** on the new account. It lists everything the token can see; tick what Watchbell should watch and save
   the selection. Nothing is watched until you choose.

Each account in the drawer also has **Test connection** (re-checks the stored token and updates the account's status:
a rejected token marks the account as needing attention), **Replace credential** and **Remove**. Providers that allow
one account (Vercel, GitHub and the GitHub PR-write token) offer no second one once connected.

Tokens are encrypted with `OPS_ENCRYPTION_KEY` (AES-256-GCM) before they are saved, are never sent to your browser and
are never shown again. To change one, use **Replace credential**: the old one is deleted as soon as the new one works.
Removing an account deletes its token from Watchbell and stops watching its resources; nothing changes at the
provider. Watchbell warns you 14 days before a token with an expiry date runs out (an alert called
CredentialExpiring).

Use the smallest permissions that cover what you want. Each section below lists the read-only set first and the
extra permissions only some actions need. Where a provider has no read-only tokens, actions always ask you to confirm.

## Vercel

- Create: https://vercel.com/account/settings/tokens (an **Access token**).
- Scope: your account (or the team that owns your projects).
- Set an expiry date; Watchbell reminds you before it ends.
- One Vercel account per Watchbell.

Vercel tokens can't be read-only. Watchbell uses the token to list projects, deployments, domains, request logs and
analytics, and, only when you (or an approved auto-action) ask, to redeploy, roll back or promote.

## Supabase

- Create: https://supabase.com/dashboard/account/tokens. Use a **scoped access token**, not a full-access one.
- Several Supabase accounts are allowed (each has its own two free active projects).

Read-only permissions for watching:

| Permission | What it is for |
|---|---|
| Projects: Read | Status, region, Postgres version |
| Project admin: Read | Service health |
| Analytics usage: Read | Last API traffic and the auto-pause risk |
| Organization admin: Read | The free plan, for the free-slot count |
| Database: Read | Database size, once a day (checked at the first daily read, because testing it would query your database) |

Add these only for the features that need them:

| Permission | Needed for |
|---|---|
| Project admin: Write | Pause and restore a project, Auto-restore |
| Database: Read-write and Connection pooling: Read | Setting up the read-only SQL role automatically (see [SQL console](sql-console.md)) |
| Organization: Projects: Create (`organization_projects_create`) | Creating a new project from a create request (free plan organizations only) |

## Neon

- Create: https://console.neon.tech/app/settings/api-keys (a personal, organization or project **API key**).
- Several Neon accounts are allowed.

Neon has no read-only keys, so the key stays on the server and every action asks for confirmation. Watchbell reads
compute state, CU-hours, storage and transfer; reading them never wakes a compute. Waking a compute and creating a
branch use the same key.

## Firebase

- Create: https://console.cloud.google.com/iam-admin/serviceaccounts. Make a **service account** and download its
  key as JSON, then paste the whole JSON file into Watchbell.
- Give it these roles on each project you want to watch, and nothing more:
  `firebase.viewer`, `datastore.viewer`, `monitoring.viewer`, `firebaseauth.viewer`.
- Turn on the **Cloud Monitoring API** in each project, so Watchbell can read today's reads, writes and deletes.
- One service account per Google account.

The same service account runs the Firestore query builder in the [SQL console](sql-console.md) (it needs
`datastore.viewer`).

**Creating Firebase projects** (optional) uses a separate Google sign-in with the `cloud-platform` scope, because
viewer roles can't create projects. It needs the same Google OAuth client as [Backups](backups.md): set
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and add `<SITE_URL>/auth/google/create/callback` as a second
authorized redirect URI. Then use **Connect Google (create projects)** on the Firebase page.

## Turso

- Create: https://app.turso.tech/account/api-tokens, or with the Turso CLI:

  ```bash
  turso auth api-tokens mint watchbell --org <your-org>
  ```

- Use a **platform API token** limited to one organization. A database or group token won't work: those can't list
  anything.
- Several Turso accounts are allowed.

Turso has no read-only platform tokens. Watchbell only lists databases and reads this month's rows read and written and
storage against the free plan.

## Upstash

- Create: https://console.upstash.com/account/api. Make a **Developer API key** and choose **Read Only**
  (Account, Management API).
- Paste it as `your-email:API_KEY` (your Upstash login email, a colon, then the key). Upstash signs API calls with
  both.
- Several Upstash accounts are allowed.
- Only databases created in an Upstash account can be read. A Redis database made through the Vercel integration
  can't be read this way.

## Cloudflare

- Create: https://dash.cloudflare.com/profile/api-tokens (**Create Token**, then a custom token).
- Several Cloudflare accounts are allowed.

Read-only permissions for watching:

| Permission | What it is for |
|---|---|
| Zone: Zone: Read | Your zones |
| Zone: DNS: Read | DNS records |
| Zone: SSL and Certificates: Read | Certificates |
| Zone: Zone Settings: Read (optional) | Each zone's SSL/TLS mode |
| Account: D1: Read (optional) | Watching Cloudflare D1 databases (size and tables) |
| Account: Account Analytics: Read (optional) | D1 rows read and written |

Add only if you want it:

| Permission | Needed for |
|---|---|
| Zone: DNS: Edit | Editing and adding records from the DNS records page, and "Set DNS only" on Domains. Records are never deleted. |

Not needed: Registrar. Domain expiry comes from RDAP, which is public.

## GitHub (read-only)

- Create: https://github.com/settings/personal-access-tokens/new (a **fine-grained token**, it starts with
  `github_pat_`). Classic tokens can't be limited to read-only.
- Repository access: all repositories, or only the ones your apps deploy from.
- Repository permissions, each **Read-only**: Metadata, Contents, Actions. Nothing else.
- Set an expiry date.

Sync lists your repositories, apps are linked to theirs, and the app page shows their GitHub Actions status and
dependency advisories. The Repositories page browses them. When GitHub refuses a read (a permission was left out or
removed later), the account in Connections reads **Connected, some reads refused** and names the permission to add.

## GitHub (PR write)

Optional, and a **separate** fine-grained token from the read-only one. Watchbell uses it only to open pull requests
that update vulnerable packages (when you approve one, or by itself with automatic security fixes) and to merge its own
update pull requests when you allow that. It never pushes to your default branch directly.

- Create: https://github.com/settings/personal-access-tokens/new.
- Repository access: **Only select repositories**, the ones you want update pull requests for.
- Repository permissions: Contents: Read and write, Pull requests: Read and write, Commit statuses: Read (for
  automatic merges). Nothing else (GitHub adds Metadata: Read itself).
- Set an expiry date.

See [Auto-actions](auto-actions.md#automatic-security-fixes).

## When a token is missing a permission

- **Test connection fails** with a permission message: the token can't do the basic reads. Create a new one with the
  read permissions above and use Replace credential.
- **An action fails with "missing permission"** (for example `database_write` when setting up the Supabase SQL role,
  or "can't add DNS records" for Cloudflare): the token can read but not do that action. Either create a token with the
  extra permission from the tables above and use Replace credential, or do that step by hand at the provider.
- **A banner says a connection needs attention**: the token expired or was revoked. Data from that account isn't being
  updated until you replace it.

See also [Troubleshooting](troubleshooting.md#a-token-is-missing-a-permission).
