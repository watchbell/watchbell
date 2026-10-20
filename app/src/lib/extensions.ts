import type { ComponentType } from "react";
import { registry } from "@ext/registry";
import type { NavItem } from "@/lib/nav";
import type { CallbackHandler } from "@/lib/notify/telegram-updates";

// R1: the ONE point where the core reaches the private feature. "@ext/registry" resolves to src/private/registry.ts
// when it exists, else to src/lib/extensions-none.ts (tsconfig paths, next.config.ts turbopack.resolveAlias,
// vitest.config.mts). No other core file may import "@ext/registry" or anything under src/private (extensions.test.ts).
//
// Server-only use: the registry may pull in server code (daily steps, slot components that read the database). Client
// components never import this module; they get the nav and palette entries as props from the (console) layout.

export type ExtensionNavGroup = { group: string; after: string; items: (NavItem & { ownerOnly: true })[] };
export type PaletteEntry = { label: string; href: string; keywords?: string[] };

export type Extension = {
  nav: ExtensionNavGroup[];
  palette: PaletteEntry[]; // owner only (filtered by the caller)
  WhyAiSlot?: ComponentType<{ appId: string }>; // under the problems in the Why dialog, owner only
  RecSummarySlot?: ComponentType<{ count: number }>; // top of the Recommendations card on Overview, owner only
  AiNotesSlot?: ComponentType<{ appId?: string }>;
  DevNotesSlot?: ComponentType<{ appId: string }>; // Stage 9 slice 3: an extension's notes under Repository on an app's page, owner only // AI notes: Overview Recommendations card (all), app page (that app), owner only
  dailySteps?: { name: string; run: (now: Date) => Promise<void> }[]; // after the core daily steps, each in try/catch
  // After every per-minute collector run, outside its response (after()); each must stay cheap when it has nothing to
  // do, bound its own time and never throw (the route catches anyway). E.g. the 07:00/19:00 WIB advisor notes, the
  // 10:00 WIB office meeting. ctx.deadline: the epoch ms by which the step must be done (the route's 60 s, less a margin).
  minuteSteps?: { name: string; run: (now: Date, ctx?: { deadline: number }) => Promise<void> }[];
  // A top-bar button that opens `frame` in a drawer (components/shell/extension-drawer.tsx); `href` is the full page. The
  // private edition's Kantor Virtual (owner 14 Oct). Plain data, owner only (the (console) layout sends it to owners alone).
  office?: DrawerLink;
  // Extra Settings tabs after the core ones (the Settings page is Owner only). `key` is also the ?tab= value.
  settingsTabs?: SettingsTab[];
  // Stage 9 slice 7: a Telegram button tap, already checked by the core webhook (connected chat + linked owner).
  telegramCallback?: CallbackHandler;
  // Stage 9 slice 4: the VM runner on the owner's machine (private edition). Without it the core still asks GitHub
  // Actions for an update PR's lockfile (lib/data/deps-pr.ts) and the merge watcher sees no runner job.
  runner?: RunnerExtension;
  // The runner's preview of a repository (Run / Stop, status, logs), under Repository on its page, owner only.
  RepoPreviewSlot?: ComponentType<{ repoId: string }>;
};

// An update PR's lockfile job: the PR branch at its head commit and the packages it raises.
export type LockfileJob = {
  repoId: string; branch: string; headSha: string; prNumber: number; lockfilePath: string | null; targets: { name: string; version: string }[];
};
// Both never throw (a database hiccup answers "not queued" / false).
export type RunnerExtension = {
  queueLockfileJob(job: LockfileJob): Promise<{ queued: true; jobId: string } | { queued: false; why: string }>;
  // A lockfile job for this PR branch is still queued or running.
  lockfileJobActive(repoId: string, branch: string): Promise<boolean>;
};

export type SettingsTab = { key: string; label: string; Tab: ComponentType };

// label: the top-bar button's accessible name; title: the drawer's heading and the iframe's title; openLabel: the link to href.
export type DrawerLink = { href: string; frame: string; label: string; title: string; openLabel: string };

// What the client shell needs (plain data, serialisable): the owner's extra nav groups, palette entries and office link.
export type ClientExtension = Pick<Extension, "nav" | "palette" | "office">;

export const extensions: Extension = registry;
