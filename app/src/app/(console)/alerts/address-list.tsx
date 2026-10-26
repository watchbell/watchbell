"use client";

import { IconX } from "@tabler/icons-react";
import { useState } from "react";
import { MAX_RECIPIENTS, recipients } from "@/lib/notify/hints";

// 1.2.4: the SMTP "Send to" field as a row of addresses. Enter, a comma, a space or leaving the field adds what was
// typed; Backspace in an empty field takes the last one back. `onChange` gets every address plus the one being typed,
// comma-separated, so Save never loses a typed address; the server splits and checks them (smtpProblems).
export function AddressList({ id, onChange }: { id: string; onChange: (to: string) => void }) {
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const update = (next: string[], text: string) => {
    setList(next);
    setDraft(text);
    onChange([...next, text.trim()].filter(Boolean).join(", "));
  };
  const commit = (text: string) => update(recipients([...list, text].join(",")), "");

  return (
    <div className="flex min-h-[34px] flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-1.5 py-1 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/40">
      {list.map((a, i) => (
        <span key={a} className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken py-0.5 pl-2.5 pr-1 text-[12.5px]">
          {a}
          <button type="button" className="grid size-4 place-items-center rounded-full text-ink-soft hover:text-ink" aria-label={`Remove ${a}`}
            onClick={() => update(list.filter((_, j) => j !== i), draft)}>
            <IconX size={12} aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="min-w-[160px] flex-1 bg-transparent px-1 py-0.5 text-ink outline-none"
        type="text"
        inputMode="email"
        autoComplete="off"
        placeholder={list.length ? (list.length < MAX_RECIPIENTS ? "Add another" : "") : "you@example.com"}
        value={draft}
        onChange={(e) => (/[\s,;]/.test(e.target.value) ? commit(e.target.value) : update(list, e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) { e.preventDefault(); commit(draft); }
          else if (e.key === "Backspace" && !draft && list.length) update(list.slice(0, -1), list.at(-1)!);
        }}
        onBlur={() => { if (draft.trim()) commit(draft); }}
      />
    </div>
  );
}
