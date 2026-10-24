"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { loadPaletteSource } from "@/app/(console)/palette-action";
import { usePrivacy, useMask } from "@/components/alias";
import type { ClientExtension } from "@/lib/extensions";
import type { Role } from "@/lib/roles";
import type { SectionId } from "@/lib/sections";
import { cn } from "@/lib/utils";
import { buildItems, type PaletteItem, type PaletteSource, rankShown } from "@/lib/view/palette";
import { NAV_ICONS } from "./nav-icons";
// The mockup's Ctrl K palette: a centred panel over a scrim, one input, a list that filters as you type.
// The watched apps and monitors are fetched each time it opens (a Server Action that any member may call), so no page
// render pays for them and an app added in Sync shows up on the next opening. The previous list stays visible while the
// new one loads, and the pages are listed before the first one arrives.
export function CommandPalette({
  role, ext, sections, open, opener, onOpen, onClose,
}: { role: Role; ext: ClientExtension; sections?: SectionId[]; open: boolean; opener: Element | null; onOpen: (opener: Element | null) => void; onClose: () => void }) {
  const [source, setSource] = useState<PaletteSource | null>(null);
  const [failed, setFailed] = useState(false);
  const inflight = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat) return;
      if (open) onClose();
      else onOpen(document.activeElement);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpen, onClose]);

  useEffect(() => {
    if (!open || inflight.current) return;
    inflight.current = true;
    loadPaletteSource()
      .then((r) => {
        if (r.ok && r.data) { setSource(r.data); setFailed(false); } else setFailed(true);
      })
      .catch(() => setFailed(true))
      .finally(() => { inflight.current = false; });
  }, [open]);

  const items = useMemo(() => buildItems(role, source, ext, sections), [role, source, ext, sections]);
  if (!open) return null;
  return <PaletteDialog items={items} loading={source === null && !failed} opener={opener} onClose={onClose} />;
}

// Mounted only while open, so every opening starts with an empty input and the first item selected. It gives focus back
// to the element that opened it (the topbar button, or wherever Ctrl K was pressed) when it closes.
export function PaletteDialog({
  items, loading, opener = null, onClose,
}: { items: PaletteItem[]; loading: boolean; opener?: Element | null; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  // Screenshot mode: apps and monitors show masked (app-a, app-a.example) and are found by either name.
  const { shot } = usePrivacy();
  const mask = useMask();
  const display = useMemo(() => items.map((i) => (i.id.startsWith("page:") ? i : { ...i, label: mask("text", i.label), hint: mask("text", i.hint) })), [items, mask]);
  const shown = useMemo(() => rankShown(items, shot ? display : items, query), [items, display, shot, query]);
  const at = Math.min(sel, Math.max(0, shown.length - 1));
  const optionId = (i: number) => `${id}-opt-${i}`;

  // Focus the input from an effect, not autoFocus: Strict Mode's simulated unmount hands focus back to the opener and
  // this runs again on the simulated remount, so the input ends up focused in dev and in production alike.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); }, [opener]);
  useEffect(() => {
    document.getElementById(`${id}-opt-${at}`)?.scrollIntoView?.({ block: "nearest" });
  }, [id, at, shown]);

  // Esc closes from anywhere, and Tab stays inside: the input is the only thing in the panel that takes focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function go(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    router.push(item.href);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") { setSel(Math.min(at + 1, shown.length - 1)); e.preventDefault(); }
    if (e.key === "ArrowUp") { setSel(Math.max(at - 1, 0)); e.preventDefault(); }
    if (e.key === "Enter") { go(shown[at]); e.preventDefault(); }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/45 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        // A click on the panel (padding, "No matches", an option) must not move focus out of the input.
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}
        className="w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[10px] border border-line-strong bg-surface shadow-[0_16px_48px_rgba(0,0,0,.25)]">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={shown.length > 0 ? `${id}-list` : undefined}
          aria-activedescendant={shown.length > 0 ? optionId(at) : undefined}
          aria-autocomplete="list"
          aria-label="Search"
          autoComplete="off"
          placeholder="Jump to a page, app, database, or domain"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={onInputKey}
          className="w-full border-0 border-b border-line bg-transparent px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-ink-faint"
        />
        {shown.length > 0 ? (
          <ul id={`${id}-list`} role="listbox" aria-label="Results" className="m-0 max-h-[360px] list-none overflow-y-auto p-1.5">
            {shown.map((item, i) => {
              const Icon = NAV_ICONS[item.icon];
              return (
                <li
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === at}
                  onMouseMove={() => { if (i !== at) setSel(i); }}
                  onClick={() => go(item)}
                  className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2", i === at && "bg-brand-soft")}
                >
                  <Icon size={17} className="shrink-0 text-ink-faint" />
                  <span className="min-w-0 truncate">{item.label}</span>
                  <small className="ml-auto shrink-0 pl-3 text-[12.5px] text-ink-faint">{item.hint}</small>
                </li>
              );
            })}
          </ul>
        ) : (
          <p role="status" className="m-0 p-4 text-ink-soft">{loading && query.trim() ? "Loading apps…" : "No matches"}</p>
        )}
      </div>
    </div>
  );
}
