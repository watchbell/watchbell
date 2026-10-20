"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "!bg-surface !text-ink !border !border-line-strong !rounded-lg",
          description: "!text-ink-soft",
        },
      }}
      {...props}
    />
  );
}
