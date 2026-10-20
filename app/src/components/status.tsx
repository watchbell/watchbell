import {
  IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconCircleX,
  IconHammer, IconHelpCircle, IconInfoCircle, IconLoader2, IconMoon, IconPlayerPause, IconTool,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { type State, STATE_TONE } from "@/lib/status";
import { cn } from "@/lib/utils";

const ICONS: Record<State, typeof IconCircleCheck> = {
  ok: IconCircleCheck, warn: IconAlertTriangle, err: IconAlertCircle, idle: IconMoon, build: IconLoader2,
  paused: IconPlayerPause, info: IconInfoCircle, fail: IconCircleX, off: IconCircleDashed, unknown: IconHelpCircle, maint: IconTool,
};

// `still`: a row that records something that happened (an event list) shows a build as a hammer, not the spinner: a past
// "Deployment started" must not spin forever. Only a live build (an ongoing deployment) keeps the spinner.
export function StateIcon({ state, size = 17, still = false }: { state: State; size?: number; still?: boolean }) {
  const Icon = still && state === "build" ? IconHammer : ICONS[state];
  return <Icon size={size} aria-hidden className={cn("shrink-0", STATE_TONE[state], state === "build" && !still && "animate-spin")} />;
}

export function Status({ state, children }: { state: State; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <StateIcon state={state} />
      <span>{children}</span>
    </span>
  );
}
