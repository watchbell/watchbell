import { describe, expect, it } from "vitest";
import { actionsStatus, linkSourceText, suggestionWhy } from "./github";

const run = (status: string, conclusion: string | null) => ({ status, conclusion, name: "CI", branch: "main", sha: "abc", url: null, at: null, runNumber: 1 });

describe("actionsStatus", () => {
  it("says not read yet and no runs plainly", () => {
    expect(actionsStatus(null, "main")).toEqual({ state: "unknown", label: "Not read yet" });
    expect(actionsStatus({ none: true }, "main")).toEqual({ state: "off", label: "No workflow runs on main" });
  });
  it("maps GitHub's status and conclusion to the console's states", () => {
    expect(actionsStatus(run("in_progress", null), "main")).toEqual({ state: "build", label: "Running" });
    expect(actionsStatus(run("queued", null), "main")).toEqual({ state: "build", label: "Queued" });
    expect(actionsStatus(run("completed", "success"), "main")).toEqual({ state: "ok", label: "Passing" });
    expect(actionsStatus(run("completed", "failure"), "main")).toEqual({ state: "err", label: "Failing" });
    expect(actionsStatus(run("completed", "timed_out"), "main").state).toBe("err");
    expect(actionsStatus(run("completed", "action_required"), "main")).toEqual({ state: "warn", label: "Waiting for approval" });
    expect(actionsStatus(run("completed", "cancelled"), "main")).toEqual({ state: "off", label: "Cancelled" });
    expect(actionsStatus(run("completed", "weird"), "main")).toEqual({ state: "unknown", label: "weird" });
  });
  it("words where a link came from and why a repo is suggested", () => {
    expect(linkSourceText("vercel")).toBe("from the Vercel project's Git link");
    expect(suggestionWhy("package")).toBe("its package.json name matches the app");
  });
});
