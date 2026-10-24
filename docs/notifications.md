# Notifications

Watchbell can send alerts to Telegram, to a Discord channel and as a daily email. All three are free and optional, and
they are set up on **Alerts › Notifications** (owner only; everyone else sees their status).

- [What gets sent](#what-gets-sent)
- [Telegram](#telegram)
- [Discord](#discord)
- [Daily email digest](#daily-email-digest)
- [Language](#language)
- [Quiet rules](#quiet-rules)

## What gets sent

- **Telegram and Discord:** one message per collector run, listing every alert that opened, is still firing (repeated
  every 6 hours) or resolved. Auto-action proposals and results also go to Telegram (see
  [Auto-actions](auto-actions.md)).
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
- An alert resolves only after 2 good checks in a row, so a flapping site doesn't page you twice.
- An alert in a maintenance window doesn't open at all (see [Pages › Uptime](pages.md#hosting)).
- A silenced alert sends nothing until the silence ends.

If nothing arrives at all, see [Troubleshooting](troubleshooting.md#no-notifications-arrive).
