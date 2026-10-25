"use client";

import { useState } from "react";

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }
  // The status span is always there (empty until a copy), so screen readers announce "copied" when it fills in.
  return (
    <>
      <button type="button" className="copy" onClick={copy}>
        {copied ? done : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? done : ""}
      </span>
    </>
  );
}
