"use client";

import { createContext, type KeyboardEvent, type MouseEvent, type ReactNode, useContext, useState } from "react";
import { cn } from "@/lib/utils";
import { accountAlias, type AliasBook, appAlias, dbAlias, EMAIL_HIDDEN, EMPTY_BOOK, hideEmails, maskText, SHOT_COOKIE } from "@/lib/view/display-name";

// Privacy (lib/view/display-name.ts). The console layout reads the stable letters once per render and provides them
// here with screenshot mode, so every client or server component can show a masked value without passing them down.
//
// Screenshot mode lives in a cookie (SHOT_COOKIE), not localStorage: the layout reads it, so the server already renders
// the masked page and nothing real flashes before hydration, and server and client render the same text (no hydration
// mismatch). The toggle writes the cookie and flips the state at once; it is per browser and defaults to off.

type Privacy = { book: AliasBook; shot: boolean; setShot: (on: boolean) => void; gen: number };
const Ctx = createContext<Privacy>({ book: EMPTY_BOOK, shot: false, setShot: () => {}, gen: 0 });

function writeShot(on: boolean) {
  try {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${SHOT_COOKIE}=${on ? "1" : ""}; path=/; max-age=${on ? 31_536_000 : 0}; samesite=lax${secure}`;
  } catch {
    // Cookies blocked: the mode still works until the page reloads.
  }
}

export function AliasProvider({ book, shot: initial = false, children }: { book: AliasBook; shot?: boolean; children: ReactNode }) {
  const [shot, setShotState] = useState(initial);
  // Each change of mode starts a new "generation": a value revealed before it is masked again (reveal lasts until the
  // page reloads or the mode is turned off).
  const [gen, setGen] = useState(0);
  const setShot = (on: boolean) => {
    setShotState(on);
    setGen((g) => g + 1);
    writeShot(on);
  };
  return <Ctx.Provider value={{ book, shot, setShot, gen }}>{children}</Ctx.Provider>;
}

export const usePrivacy = () => useContext(Ctx);
export const useAliasBook = () => useContext(Ctx).book;

const revealClass = "cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
const revealedClass = "underline decoration-dotted decoration-1 underline-offset-[3px]";

// A masked value: the alias until clicked (or Enter/Space on focus), then the real value for this element only, with a
// dotted underline so it reads as "real". A <button>; inside a link (`inLink`) it is a focusable span instead, so the
// first click reveals instead of following the link (the next one follows it).
export function Reveal({ shown, real, inLink, className }: { shown: string; real: string; inLink?: boolean; className?: string }) {
  const { gen } = usePrivacy();
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = openAt === gen;
  const title = open ? "Real value. Click to hide it." : "Hidden. Click to show the real value.";
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenAt(open ? null : gen);
  };
  if (inLink) {
    return (
      <span
        role="button" tabIndex={0} aria-pressed={open} title={title}
        onClick={(e) => { if (!open) toggle(e); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(e); }}
        className={cn(revealClass, open && revealedClass, className)}
      >
        {open ? real : shown}
      </span>
    );
  }
  return (
    <button
      type="button" aria-pressed={open} title={title} onClick={toggle}
      className={cn("inline appearance-none border-0 bg-transparent p-0 text-left align-baseline text-inherit [font:inherit]", revealClass, open && revealedClass, className)}
    >
      {open ? real : shown}
    </button>
  );
}

// A database's name, everywhere and always (Part 1): its alias (db-a) with click to reveal. `alias` overrides the
// provided letters, for a row that arrived after the page did (the Sync dialog's freshly synced projects).
export function DbName({ id, name, alias, inLink, className }: { id: string; name: string; alias?: string; inLink?: boolean; className?: string }) {
  const book = useAliasBook();
  // the revealed name never shows an address (Supabase names a default project "<email>'s Project")
  return <Reveal shown={alias ?? dbAlias(book, id)} real={hideEmails(name)} inLink={inLink} className={className} />;
}

export type MaskKind = "app" | "account" | "email" | "repo" | "text";

// What a value looks like now. Off: the real value without emails (a member's address, kind "email", stays: Settings
// lists members by it). On: app-a, account-1, "[email hidden]", owner/app-a for a repository, or the text with every
// name, host and email masked.
export function maskedValue(kind: MaskKind, real: string, book: AliasBook, shot: boolean): string {
  if (!shot) return kind === "email" ? real : hideEmails(real);
  if (kind === "app") return appAlias(book, real);
  if (kind === "account") return accountAlias(book, real);
  if (kind === "email") return EMAIL_HIDDEN;
  // A Git repository "owner/name": the owner is a username, so it goes too.
  if (kind === "repo") return `owner/${maskText(real.split("/").slice(1).join("/") || real, book)}`;
  return maskText(real, book);
}

// Screenshot mode (Part 2): an app, an account, an address or any text with names in it. Masking is display only:
// links, actions, forms and copy buttons around it keep the real value.
// `masked` overrides what screenshot mode shows, for text whose private part isn't a known name (a Telegram chat's title).
export function Masked({ kind, real, masked, inLink, className }: { kind: MaskKind; real: string; masked?: string; inLink?: boolean; className?: string }) {
  const { book, shot } = usePrivacy();
  const shown = shot && masked !== undefined ? maskText(masked, book) : maskedValue(kind, real, book, shot);
  if (!shot || shown === real) return <>{shown}</>;
  return <Reveal shown={shown} real={real} inLink={inLink} className={className} />;
}

export const MaskedText = ({ text, inLink }: { text: string; inLink?: boolean }) => <Masked kind="text" real={text} inLink={inLink} />;

// For strings that can't hold a button: an <option>, a placeholder, an aria-label.
export function useMask(): (kind: MaskKind, real: string) => string {
  const { book, shot } = usePrivacy();
  return (kind, real) => maskedValue(kind, real, book, shot);
}
