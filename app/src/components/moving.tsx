import { IconLoader2 } from "@tabler/icons-react";

// 1.8.1 (owner, 15 Nov): while a move runs, the place it was started says where to, with a spinner. The wait is the
// server moving the rows, expiring its cached lists and drawing the page again.
export const movingLabel = (to: string): string => `Moving to ${to}…`;

export function Moving({ to }: { to: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-ink-soft">
      <IconLoader2 size={14} className="animate-spin" aria-hidden />
      {movingLabel(to)}
    </span>
  );
}
