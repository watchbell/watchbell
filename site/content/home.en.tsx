import type { HomeCopy } from "./types";

// English home copy: the approved mockup (mockup/site-home.html), word for word.
export const homeEn: HomeCopy = {
  title: "Watchbell: watches your free-plan apps and asks before it fixes",
  description:
    "Watchbell watches your Vercel apps, databases and domains on free plans, and asks you on Telegram before it fixes anything. Free, open source, runs on your machine.",
  hero: {
    clock: "03:12 — orbit-blog stopped answering",
    title: "Your site went down at 3 a.m.",
    titleSoft: "You fixed it from bed.",
    lede: (
      <>
        Watchbell watches your Vercel apps, databases and domains on free plans. When something breaks it{" "}
        <b>works out a fix and asks you first</b>, on Telegram. Two taps, and it&apos;s back.
      </>
    ),
    setup: "Set it up tonight",
    docs: "Read the docs",
    note: (
      <>
        Free, open source, runs on <code>your</code> machine.
      </>
    ),
  },
  phone: {
    label: "Telegram conversation with Watchbell",
    bot: "bot",
    first: (
      <>
        <span className="red">orbit-blog is down.</span>
        <br />
        No answer on 3 checks in a row. The deploy from 02:58 is the likely cause.
        <br />
        <br />
        Roll back to the previous deployment?
      </>
    ),
    approve: "Approve",
    reject: "Reject",
    sure: "Rolling back production. Sure?",
    yes: "Yes, roll back",
    cancel: "Cancel",
    back: (
      <>
        <span className="grn">orbit-blog is back.</span> Answered in 184 ms. Go back to sleep.
      </>
    ),
  },
  night: {
    eyebrow: "One night with Watchbell",
    title: "What actually happened.",
    sub: "Everything below is what Watchbell does today, on a laptop or a small server, with your own free accounts.",
    pushed: {
      title: "You pushed a small change and went to bed.",
      text: "Vercel built it and put it live. Watchbell saw the new deployment come in.",
    },
    down: {
      title: "The site stopped answering.",
      text: "Watchbell checks every app once a minute. Three misses in a row, so it is down, not just slow.",
    },
    asked: {
      title: "It asked. You said yes. Twice.",
      text: "Risky fixes never run on their own. A rollback asks for a second tap, so a sleepy thumb can't do it by accident. It works without a public address: no webhook, no tunnel.",
    },
    fixed: {
      title: "Back up, and checked.",
      text: "Watchbell rolled production back to the last good deployment, then checked the site again before calling it fixed.",
      response: "response",
      downFor: "down for",
      downForValue: "2 min 40 s",
      action: "action",
      actionValue: "rollback · approved by you",
    },
    morning: {
      title: "Over coffee, the short version.",
      text: "A morning email with what happened overnight, plus the things that are about to become a problem.",
      head: "From: Watchbell · Subject: Daily summary, 21 Oct",
      summary: (
        <>
          <b>1 incident, fixed.</b> orbit-blog was down 03:12–03:14; rolled back.
        </>
      ),
      items: [
        'Supabase "shop-db": 82% of the free database size.',
        "status.acme-studio.example: certificate renews in 12 days.",
        'Neon "analytics": 46 of 100 compute hours used.',
      ],
    },
    desk: {
      title: "At your desk, everything on one board.",
      text: "Open Watchbell and the whole night is there: the incident, the rollback, who approved it, and the state of everything else.",
    },
  },
  board: {
    eyebrow: "The board",
    title: "Every app, database and domain. One page.",
    sub: "Read through each provider's own API, with a token you paste once and that never leaves your machine.",
    label: "Watchbell status board",
    status: "Status",
    checked: "checked 14 s ago · every 60 s",
    date: "Tue 21 Oct · 09:30",
    cols: ["Name", "State", "Detail", "Last 90 days"],
    groups: { apps: "Apps · Vercel", databases: "Databases", domains: "Domains" },
    apps: [
      { name: "orbit-blog", host: "orbit-blog.example", state: "recovered", kind: "rec", detail: "184 ms · rolled back 03:14", bad: [89], warn: [40, 41] },
      { name: "acme-shop", host: "shop.example", state: "up", kind: "ok", detail: "212 ms", warn: [17] },
      { name: "ember-status", host: "status.ember.example", state: "up", kind: "ok", detail: "96 ms", warn: [63, 64] },
    ],
    databases: [
      { name: "shop-db", host: "Supabase · Singapore", state: "82% full", kind: "warn", detail: "412 / 500 MB · kept awake" },
      { name: "analytics", host: "Neon · compute asleep", state: "idle", kind: "idle", detail: "46 / 100 CU-h this month" },
    ],
    domains: [
      { name: "status.acme-studio.example", host: "Cloudflare DNS → Vercel", state: "cert 12 d", kind: "warn", detail: "registration 214 d" },
      { name: "shop.example", host: "Cloudflare DNS → Vercel", state: "valid", kind: "ok", detail: "cert 71 d · registration 1 y" },
    ],
    footLeft: "8 resources · 1 recovered tonight · 2 need attention soon",
    footRight: "Made-up example data",
    providers: (
      <>
        Works with <b>Vercel</b>, <b>Supabase</b>, <b>Neon</b>, <b>Firebase</b>, <b>Turso</b>, <b>Upstash Redis</b>,{" "}
        <b>Cloudflare</b> (DNS and D1) and <b>GitHub</b>.
      </>
    ),
  },
  also: {
    eyebrow: "It also keeps an eye on",
    title: "The slow problems, not just the loud ones.",
    items: [
      { term: "Free-plan limits", text: "Usage against every free limit, with an alert before the edge, not after.", meter: true },
      {
        term: "Sleepy databases",
        text: "A free Supabase project pauses after a quiet week. Watchbell warns on day 5 and keeps it awake. Neon is read without waking the compute.",
      },
      {
        term: "Certificates and domains",
        text: "Certificate and registration expiry, and a warning when Cloudflare's proxy sits in front of Vercel.",
      },
      {
        term: "Your cron jobs",
        text: (
          <>
            Each job pings its own address; Watchbell tells you when a ping is late. <span className="tag">/api/ping/&lt;token&gt;</span>
          </>
        ),
      },
      { term: "Vulnerable packages", text: "Advisories for your GitHub repos, and a proposed pull request that updates the package." },
      { term: "Read-only SQL", text: "Query Supabase and Neon as a role that can't write, inside a transaction that is rolled back anyway." },
      {
        term: "AI, if you want it",
        text: "Your own Gemini, Workers AI or local Ollama key, behind one OpenAI-compatible endpoint and an MCP server. Off by default.",
      },
      { term: "A status page", text: "An optional public page and uptime badges for your READMEs." },
    ],
  },
  setup: {
    eyebrow: "Set it up tonight",
    title: "Two commands. No account.",
    steps: [
      <>
        <b>Install Node.js 24</b>, if you don&apos;t have it.
      </>,
      <>
        <b>Install Watchbell:</b> <code>npm install -g watchbell</code>. Prebuilt, nothing to compile.
      </>,
      <>
        <b>Start it:</b> <code>watchbell</code>, then open the address it prints and enter the one-time code.
      </>,
      <>
        <b>Connect Telegram</b> and paste a Vercel token. That&apos;s the 03:12 part sorted.
      </>,
    ],
    copy: "copy install command",
    copied: "copied",
    installers: "installers for Linux and Windows →",
    terminal: "Terminal",
  },
  fine: {
    eyebrow: "The fine print",
    rows: [
      ["Runs on", "Linux, Windows 10/11 and macOS, with Node.js 24. The database is built in."],
      [
        "Your data",
        <>
          Stays in <code>~/.watchbell</code>. Tokens are encrypted (AES-256-GCM).
        </>,
      ],
      ["Talks to", "Only what you connect, plus npm once a day to see if there's a new version (you can turn it off)."],
      ["While asleep", "A sleeping laptop checks nothing. For the 03:12 story, run it on a machine that stays on."],
      ["Costs", "Nothing. MIT licensed."],
    ],
    questions: "Questions",
    faq: [
      {
        q: "Do I need a server?",
        a: "No. A laptop works while it's awake. A home server, an old PC or a small VPS gives you the 3 a.m. coverage.",
      },
      {
        q: "Can I open it from my phone?",
        a: (
          <>
            It listens on its own machine by default. Use an SSH tunnel, or start it with <code>--host</code> on your home
            network. The Telegram buttons work either way.
          </>
        ),
      },
      { q: "Is there a Docker image?", a: "Not yet. Use npm or the installers." },
      { q: "Does it need AI?", a: "No. Every AI feature is optional and off until you add your own key." },
    ],
  },
};
