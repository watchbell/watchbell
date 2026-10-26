# Notifications

Bahasa Indonesia: [id/notifications.md](id/notifications.md)

Watchbell can send alerts to Telegram, to a Discord channel, to a webhook of yours, by email through your own mail
server, and as a daily email. All are free and optional, and
they are set up on **Alerts › Notifications** (owner only; everyone else sees their status).

- [What gets sent](#what-gets-sent)
- [Telegram](#telegram)
- [Discord](#discord)
- [Webhook](#webhook)
- [Email (SMTP)](#email-smtp)
- [Daily email digest](#daily-email-digest)
- [Language](#language)
- [Quiet rules](#quiet-rules)

## What gets sent

- **Telegram and Discord:** one message per collector run, listing every alert that opened, is still firing (repeated
  every 6 hours) or resolved. Auto-action proposals and results also go to Telegram (see
  [Auto-actions](auto-actions.md)).
- **One thread per alert on Telegram:** a proposal or an automatic action for an alert is sent as a reply to the
  message that opened that alert (a grouped list of more than three proposals stays a message of its own). An automatic
  **Check again now** that ran sends nothing: the alert's own messages tell whether it is still down or resolved; only a
  re-check that couldn't run is reported. Telegram is your own chat, so it names apps, databases and hosts by their real
  names; Discord, the digest and the console keep databases as db-a, db-b.
- **Email digest:** one email a day at 07:00 in your [time zone](configuration.md#time-zone): what fired, what
  resolved, uptime and stored errors of the last 24 hours.

Each channel has **Send test**, and a switch to turn it off without forgetting its settings. If a send fails, the
reason shows under the channel.

## Telegram

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot` and follow the questions. It gives you a
   bot token like `123456789:AA…`.
2. Put the token in `app/.env` and restart Watchbell:

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AA...
   ```

3. Open your new bot in Telegram and send it `/start`. For a group, add the bot to the group and send a message there.
4. In Watchbell: **Alerts › Notifications › Telegram bot › Connect**, press **Find chats**, pick the chat and save.
5. Press **Send test**.

Keep the token secret: anyone with it can send messages as your bot.

### Approval buttons

With approval buttons on, proposal messages get **Approve** and **Reject** buttons, so you can say yes to a fix from
your phone. Only your linked Telegram account can use them, and risky actions ask twice.

1. On the Telegram channel, under **Approval buttons**, press **Turn on**.
2. Press **Show link code** and send `/link <code>` in the connected chat within 10 minutes. The code works once.

### How the buttons reach a laptop

Telegram normally delivers button presses to a public HTTPS address (a webhook). A laptop has none, so a self-hosted
Watchbell asks Telegram for new updates itself (polling) every few seconds while the approval buttons are on. You
don't need a public address, a tunnel or any extra account.

Things to know:

- Buttons only work while Watchbell runs. Presses made while it is stopped or the laptop sleeps are held by Telegram
  (for up to 24 hours) and handled when Watchbell is back.
- Turning the buttons on removes any webhook the bot had. Use **one bot per Watchbell**: if the same bot is used by
  another install that relies on a webhook, the two will take each other's updates. When Watchbell finds a webhook it
  didn't set, it leaves it alone and logs "Telegram has a webhook set; turn approvals on in Alerts → Notifications to
  switch this install to polling".
- While the buttons are on, Telegram hands every message to Watchbell, so **Find chats** lists the chats the bot has
  seen since you turned them on. Send the bot a message first if a chat is missing.
- You can always approve on the Auto-actions page instead.

## Discord

1. In Discord: Channel settings › Integrations › Webhooks › New webhook › **Copy Webhook URL**.
2. In Watchbell: **Alerts › Notifications › Discord webhook › Connect**, paste the whole URL and save.
3. Press **Send test**.

The URL is encrypted before it is saved and never shown again. Anyone with the URL can post to that channel, so treat
it like a password. Discord gets the same messages as Telegram, without buttons.

## Webhook

A JSON POST to an address of yours, for n8n, Zapier, Make or your own server.

1. In your tool, create a webhook that accepts POST requests and copy its address. It must be **https** on a public
   host, port 443: Watchbell doesn't post into private networks (an n8n at `http://192.168.x.x:5678` needs an https
   address in front of it) and doesn't follow redirects.
2. In Watchbell: **Alerts › Notifications › Webhook › Connect**, paste the address, and optionally a secret (16 to
   200 characters).
3. Press **Send test**, then tick **Webhook** on the alert rules you want (Alerts › Rules › Edit), like Discord.

Each message is one request with `Content-Type: application/json`:

```json
{
  "source": "watchbell",
  "event": "alerts",
  "sentAt": "2026-10-26T08:00:00.000Z",
  "text": "FIRING · critical · MonitorDown · orbit-blog …",
  "link": "https://your-watchbell/alerts",
  "alerts": [
    { "status": "firing", "rule": "MonitorDown", "severity": "critical", "title": "orbit-blog", "message": "orbit-blog is down",
      "startedAt": "2026-10-26T07:58:00.000Z", "causedBy": null, "provider": null }
  ]
}
```

`status` is `firing`, `repeat` or `resolved`; a test has `"event": "test"` and no alerts. Databases are named
db-a, db-b, like Discord, and emails never appear. With a secret, the request carries `X-Watchbell-Timestamp` (Unix
seconds) and `X-Watchbell-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<body>` with your secret: compute
the same and compare before you trust the request. The address and the secret are encrypted before they are saved;
the console shows only the host.

## Email (SMTP)

Each alert message by email through your own mail server, for teams that live in Office 365, Zimbra or any other mail
service that speaks SMTP. (The [daily email digest](#daily-email-digest) is separate and goes through Resend.)

1. **Alerts › Notifications › Email (SMTP) › Connect**: the server, the port, the user name and password, the address
   the mail comes from and the one that gets the alerts.
2. Press **Send test**, then tick **Email (SMTP)** on the alert rules you want, like Discord.

- Port **587** or **2525** use STARTTLS, port **465** uses TLS from the start. Watchbell sends the password only after
  TLS is up and checks the server's certificate; a server that doesn't offer STARTTLS on 587 is refused instead of
  getting the password in clear. Port 25 isn't offered.
- The server must be on the public internet, as with monitors and the webhook.
- Office 365: `smtp.office365.com`, port 587, your address as the user name; with MFA on, use an app password, and
  SMTP AUTH must be allowed for the mailbox.
- The subject is the message's first line; the body is the same text as Discord, in the email digest's language, with
  a link to Alerts. Databases are named db-a, db-b and emails never appear.
- Everything is encrypted before it's saved. Change shows the form empty; leave the password empty to keep the saved
  one.

## Daily email digest

The digest is sent through [Resend](https://resend.com). The free plan allows 100 emails a day; Watchbell sends one.

1. Create a Resend account and verify a domain you own (Resend › Domains). Without a verified domain Resend only
   delivers to your own Resend account address.
2. Create an API key with **Sending access** only (it starts with `re_`).
3. Add both to `app/.env` and restart Watchbell:

   ```bash
   RESEND_API_KEY=re_...
   DIGEST_FROM=Watchbell <noreply@your-domain.example>
   ```

   `DIGEST_FROM` must use the domain you verified.
4. In Watchbell: **Alerts › Notifications › Daily email digest**, enter the address to send to and save.
5. Press **Send test**.

## Language

Each channel has its own language: **English** or **Bahasa Indonesia**. Pick it next to the channel. This changes only
what Watchbell sends; the web console stays in English.

## Quiet rules

These are built in and can't be changed. They explain why a message may not arrive:

- While **CollectorStale** fires (the collector stopped running), no other alert is sent, because the data is stale.
- A paused database mutes **MonitorDown** and **HighLatency** for the apps linked to it.
- A check on a domain its app no longer has raises **MonitorDomainMoved** (a warning) instead of **MonitorDown**, and
  no redeploy is proposed for it: the app moved, it isn't down.
- An alert resolves only after 2 good checks in a row, so a flapping site doesn't page you twice.
- An alert in a maintenance window doesn't open at all (see [Pages › Uptime](pages.md#hosting)).
- A silenced alert sends nothing until the silence ends.

If nothing arrives at all, see [Troubleshooting](troubleshooting.md#no-notifications-arrive).
