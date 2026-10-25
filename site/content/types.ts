import type { ReactNode } from "react";

// Everything on the home page that changes with the language. The layout lives in components/Home.tsx; the two
// languages (home.en.tsx, home.id.tsx) carry the same sections and the same facts.

export type StepKind = "plain" | "bad" | "you" | "good";
export type StateKind = "ok" | "warn" | "rec" | "idle";

export interface BoardRow {
  name: string;
  host: string;
  state: string;
  kind: StateKind;
  detail: string;
  /** Indexes (0–89) of the days that were not clean, for the 90-day bars. */
  warn?: number[];
  bad?: number[];
}

export interface HomeCopy {
  title: string;
  description: string;
  hero: {
    clock: string;
    title: string;
    titleSoft: string;
    lede: ReactNode;
    setup: string;
    docs: string;
    note: ReactNode;
  };
  phone: {
    label: string;
    bot: string;
    first: ReactNode;
    approve: string;
    reject: string;
    sure: string;
    yes: string;
    cancel: string;
    back: ReactNode;
  };
  night: {
    eyebrow: string;
    title: string;
    sub: string;
    pushed: { title: string; text: string };
    down: { title: string; text: string };
    asked: { title: string; text: string };
    fixed: { title: string; text: string; response: string; downFor: string; downForValue: string; action: string; actionValue: string };
    morning: { title: string; text: string; head: string; summary: ReactNode; items: string[] };
    desk: { title: string; text: string };
  };
  board: {
    eyebrow: string;
    title: string;
    sub: string;
    label: string;
    status: string;
    checked: string;
    date: string;
    cols: [string, string, string, string];
    groups: { apps: string; databases: string; domains: string };
    apps: BoardRow[];
    databases: BoardRow[];
    domains: BoardRow[];
    footLeft: string;
    footRight: string;
    providers: ReactNode;
  };
  also: { eyebrow: string; title: string; items: { term: string; text: ReactNode; meter?: boolean }[] };
  setup: {
    eyebrow: string;
    title: string;
    steps: ReactNode[];
    copy: string;
    copied: string;
    installers: string;
    terminal: string;
  };
  fine: {
    eyebrow: string;
    rows: [string, ReactNode][];
    questions: string;
    faq: { q: string; a: ReactNode }[];
  };
}
