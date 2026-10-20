"use client";

import { MaskedText, useMask } from "@/components/alias";

// A record's Content cell. A long value (a DKIM key, a TXT policy) is cut with an ellipsis so the table keeps its
// width; the whole value is in the tooltip (masked in screenshot mode, like the text itself).
export function RecordContent({ value }: { value: string }) {
  const mask = useMask();
  return <span className="block max-w-[min(34ch,40vw)] min-w-0 truncate" title={mask("text", value)}><MaskedText text={value} /></span>;
}
