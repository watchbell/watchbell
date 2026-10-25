# First run

Bahasa Indonesia: [id/first-run.md](id/first-run.md)

The first person to finish the setup page becomes the **owner** of this Watchbell. To make sure that is you, the setup
page asks for a one-time code that only someone with access to the machine can read.

## 1. Find the setup code

Every time Watchbell starts while it has no owner, it creates a new code and:

- prints it in the server log, as a line like
  `Watchbell setup code: ABCDE-FGH23 (open http://localhost:3100/setup; valid 24 h)`;
- saves it in `app/data/setup-code`.

Where to read it:

| How Watchbell runs | Where the code is |
|---|---|
| Linux service | `cat app/data/setup-code`, or `journalctl --user -u watchbell` |
| Windows Scheduled Task | `Get-Content app\data\setup-code`, or `app\data\watchbell.log` |
| Started by hand | The terminal where you ran `npm run start:selfhost` |

The code is valid for 24 hours. Restarting Watchbell replaces it with a new one (and clears failed attempts). Dashes
and spaces don't matter when you type it, and it never contains 0, O, 1, I or L.

## 2. Create the owner account

Open `http://localhost:3100/setup` (use your port if you changed it) and enter:

- the setup code;
- your email address (it is only your sign-in name; Watchbell sends no email to it unless you set up the
  [email digest](notifications.md#daily-email-digest));
- a password of at least 12 characters, twice.

Once the owner exists, the code is deleted, `app/data/setup-code` is removed, and `/setup` no longer exists.

## 3. Set up the authenticator

Owners and operators can change infrastructure, so their sign-ins need a second factor. Right after setup Watchbell
shows a QR code:

1. Scan it with an authenticator app (any TOTP app works: Google Authenticator, Microsoft Authenticator, Aegis,
   1Password, Bitwarden and others). If you can't scan, type the key shown under the QR code.
2. Type the 6-digit code the app shows.

From now on you sign in at `/signin` with your email and password, then the 6-digit code. Keep the authenticator on a
device you won't lose, or store the key in a password manager.

## 4. Connect something

The console opens on a welcome page with the first steps: connect Vercel, pick the apps to watch, add your databases.
See [Connect providers](providers.md) for each token and its permissions, then [Notifications](notifications.md) to
get alerts on your phone.

## Add more people

Settings › Users (owner only) adds members by email with a role:

| Role | Can do |
|---|---|
| Owner | Everything, including connections, users and settings. |
| Operator | Sees everything and can redeploy, restore, wake and silence alerts. |
| Viewer | Read-only. No logs and no actions. |

Watchbell sends no invitation email. It creates the account with a temporary password, shown once; give it to the
person yourself. They pick their own password at the first sign-in, and owners and operators then set up an
authenticator. Other people can only reach Watchbell if it listens on your network (see
[LAN access](configuration.md#lan-access)).

## Locked out

If you forgot your password or lost your authenticator, reset the login from the machine Watchbell runs on:

1. Stop Watchbell: `systemctl --user stop watchbell` (Linux service), `npm run stop:selfhost` in the `app` folder
   (Windows task, or any run), or Ctrl+C in the terminal that runs it.
2. In the `app` folder, run:

   ```bash
   npm run reset-login -- you@example.com
   ```

3. It prints a temporary password, valid for 7 days. It also removes the account's authenticator and ends its
   sessions.
4. Start Watchbell again, sign in with the temporary password, choose a new password and set up the authenticator
   again.

`reset-login` works for any account on this Watchbell, not only the owner. It refuses to run while Watchbell is running
("Watchbell is running on …. Stop Watchbell first"). It reads `WATCHBELL_DATA_DIR` from the shell, not from
`app/.env`, so if you moved the data folder, set it first (`WATCHBELL_DATA_DIR=/path/to/data npm run reset-login -- you@example.com`).
It also clears the sign-in wait after failed passwords for every account (behind a reverse proxy those waits are kept
per email and address together, so they can't be cleared for one email alone).

## If the setup code doesn't work

- **"That setup code is wrong"**: copy it again from `app/data/setup-code` or the newest log line. An older code from a
  previous start no longer works.
- **"That setup code has expired"**: restart Watchbell to get a new one.
- **"Too many wrong codes"**: wait the time shown, or restart Watchbell.
- **`/setup` shows "not found"**: an owner already exists. Sign in at `/signin`, or use `reset-login` above.

More in [Troubleshooting](troubleshooting.md).
