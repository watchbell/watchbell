# Alertmanager

Bahasa Indonesia: [id/alertmanager.md](id/alertmanager.md)

Prometheus Alertmanager can send its alerts to Watchbell. They open, repeat and resolve with the same notices as
Watchbell's own alerts (Telegram, Discord, webhook, email, the daily digest, Ask AI), and show in **Alerts › Firing**
with the source **Alertmanager**. Set it up on **Alerts › Sources** (owner only; everyone else sees its status). The
demo doesn't have it: it would accept alerts from the internet.

- [Set it up](#set-it-up)
- [How alerts map](#how-alerts-map)
- [Limits and answers](#limits-and-answers)
- [Replace, revoke and test](#replace-revoke-and-test)

## Set it up

1. Open **Alerts › Sources** and press **Set up Alertmanager**. Watchbell makes a secret webhook URL and shows it
   **once**: copy it before you go on. Anyone who has it can send alerts to your console, so keep it in
   `alertmanager.yml` only.
2. Merge both parts into `alertmanager.yml` (the wizard fills the URL in) and reload Alertmanager
   (`curl -X POST localhost:9093/-/reload`):

   ```yaml
   # 1. Under receivers:
   receivers:
     - name: watchbell
       webhook_configs:
         - url: https://monitor.example.com/api/alertmanager/am_…
           send_resolved: true
           max_alerts: 100

   # 2. As the first entry of your route's routes: (your own receiver and routes stay as they are)
   route:
     routes:
       - receiver: watchbell
         continue: true
         repeat_interval: 4h
   ```

   `send_resolved: true` lets Watchbell close the alert when Alertmanager does. `max_alerts: 100` keeps one message
   within Watchbell's limit. `continue: true` keeps every alert going to your other receivers too. Keep
   `repeat_interval` under 24 hours, or a still-firing alert resolves as stale here and opens again. To send only some
   alerts to Watchbell, add `matchers` to its route.
3. Send a test alert, for example `amtool alert add WatchbellTest severity=info --alertmanager.url=http://localhost:9093`.
   The wizard checks every 5 seconds for 2 minutes and says **Received** when it lands.

Alertmanager must reach your console's address. A self-hosted Watchbell on your own network works as long as
Alertmanager can open its URL.

## How alerts map

| Alertmanager | Watchbell |
|---|---|
| `alertname` and `job` (else `instance`) labels | The alert's title, like `HighErrorRate · pos-api` |
| `summary` annotation (else `description`) | The message, at most 500 characters; tokens, passwords and email addresses are hidden |
| `severity` label | `critical` and `warning` as they are, anything else `info`; none takes the default of the rule ExternalAlert |
| Fingerprint | One alert per fingerprint: a repeat touches the open alert instead of opening a second one |
| Labels | Kept (20 at most, values up to 200 characters) under **Labels** in Firing |
| `status: resolved` | Resolves the alert |

All of them use the rule **ExternalAlert** (**Alerts › Rules**): turn it off and Alertmanager's alerts open nothing;
pick its channels there. Silencing an alert works as for any other rule, and a maintenance window for **all** apps
holds new ones back.

An alert Alertmanager stops talking about for 24 hours resolves as stale (Alertmanager repeats a firing alert every
`repeat_interval`, 4 hours by default). A resolved message for an alert Watchbell never opened changes nothing.

## Limits and answers

At most 256 KB and 100 alerts a call, and 120 alerts a minute per source.

| Answer | When |
|---|---|
| `200 {"accepted": n}` | Taken in |
| `400` | Not an Alertmanager webhook body of version 4, or more than 100 alerts |
| `404` | Unknown or revoked URL |
| `413` | Body over 256 KB |
| `429` | Over 120 alerts a minute; Alertmanager retries after `Retry-After` |
| `503` | Watchbell couldn't save it; Alertmanager retries |

Watchbell keeps only a hash of the URL's secret part and its first 7 characters, and never logs a body.

## Replace, revoke and test

- **Replace URL** makes a new URL (shown once) and stops the old one at once. Put the new one in `alertmanager.yml`.
- **Revoke** stops the URL: Alertmanager's calls get 404. Alerts it already opened stay open until they resolve, or
  for 24 hours without word.
- **Send a test alert** opens an `info` alert called WatchbellTest through the same path as a real one, so you can see
  where it is sent. It resolves by itself after about 5 minutes.

The card also shows the last alert, this month's count (received and refused) and the last five received. It says
**quiet** when nothing arrived for 7 days, which is fine if nothing fired.
