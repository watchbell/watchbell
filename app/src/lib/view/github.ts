import type { RepoRun } from "@/db/schema";
import type { State } from "@/lib/status";

// App page → Repository (B7): the GitHub Actions status in the console's state words. Pure.

export type ActionsStatus = { state: State; label: string };

const RUNNING = new Set(["in_progress", "queued", "waiting", "pending", "requested"]);

export function actionsStatus(run: RepoRun | null, branch: string | null): ActionsStatus {
  if (!run) return { state: "unknown", label: "Not read yet" };
  if ("none" in run) return { state: "off", label: `No workflow runs${branch ? ` on ${branch}` : ""}` };
  if (RUNNING.has(run.status)) return { state: "build", label: run.status === "in_progress" ? "Running" : "Queued" };
  switch (run.conclusion) {
    case "success": return { state: "ok", label: "Passing" };
    case "failure": case "timed_out": case "startup_failure": return { state: "err", label: "Failing" };
    case "action_required": return { state: "warn", label: "Waiting for approval" };
    case "cancelled": return { state: "off", label: "Cancelled" };
    case "skipped": case "neutral": case "stale": return { state: "off", label: run.conclusion === "skipped" ? "Skipped" : "Neutral" };
    default: return { state: "unknown", label: run.conclusion ?? run.status };
  }
}

export const linkSourceText = (source: "vercel" | "manual"): string => (source === "vercel" ? "from the Vercel project's Git link" : "chosen by the owner");

export const suggestionWhy = (why: "name" | "package"): string => (why === "name" ? "same name as the app" : "its package.json name matches the app");
