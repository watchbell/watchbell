"use client";

import { IconLoader2 } from "@tabler/icons-react";
import { useEffect, useState } from "react";

// "Thinking… 12 s" while a provider answers (owner 14 Oct: a router combo can take ~25 s). Mount it only while the
// action runs; the count starts at 0 on every mount.
export function Thinking({ label = "Thinking…" }: { label?: string }) {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft">
      <IconLoader2 size={15} className="animate-spin" aria-hidden />{label} <span className="font-mono">{s} s</span>
    </span>
  );
}
