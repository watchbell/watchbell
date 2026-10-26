"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { fieldClass } from "@/components/kit";
import type { NotifyChannel, NotifyLang } from "@/lib/notify/lang";
import { setNotifyLanguage } from "./channel-actions";

// Owner only. Picking a language for a channel saves it at once; the select goes back to the saved value if the save fails.
export function LanguageSelect({ channel, label, saved }: { channel: NotifyChannel; label: string; saved: NotifyLang }) {
  const [value, setValue] = useState<NotifyLang>(saved);
  const [busy, start] = useTransition();

  function pick(next: NotifyLang) {
    const prev = value;
    setValue(next);
    start(async () => {
      try {
        const r = await setNotifyLanguage(channel, next);
        if (r.ok) toast.success(`${label} language saved`, { description: r.message });
        else {
          setValue(prev);
          toast.error(r.error);
        }
      } catch {
        setValue(prev);
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  return (
    <select
      aria-label={`${label} language`}
      className={`${fieldClass} w-auto min-w-[160px]`}
      value={value}
      disabled={busy}
      onChange={(e) => pick(e.target.value === "id" ? "id" : "en")}
    >
      <option value="en">English</option>
      <option value="id">Bahasa Indonesia</option>
    </select>
  );
}
