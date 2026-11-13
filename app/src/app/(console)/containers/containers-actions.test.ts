import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const ID = "a".repeat(64);
const owner = { id: "mem-1", userId: "user-1", email: "o@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), loadContainers: vi.fn(), containerDetailFor: vi.fn(), runContainerAction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/docker-db", () => ({ loadContainers: h.loadContainers, containerDetailFor: h.containerDetailFor, runContainerAction: h.runContainerAction }));

import { DEMO_CONTAINERS, DEMO_DETAIL } from "@/lib/docker/demo";
import { containerDetailAction, containerListAction, containerVerbAction } from "./containers-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.loadContainers.mockResolvedValue({ ok: true, data: { containers: [] } });
  h.containerDetailFor.mockResolvedValue({ ok: true, data: DEMO_DETAIL });
  h.runContainerAction.mockResolvedValue({ ok: true, message: "web restarted." });
});
afterEach(() => vi.unstubAllEnvs());

describe("containers actions", () => {
  it("lets operators read the list and a container's detail", async () => {
    expect(await containerListAction()).toEqual({ ok: true, data: { containers: [] } });
    expect(h.requireActionMember).toHaveBeenLastCalledWith("operator");
    expect(await containerDetailAction(ID)).toEqual({ ok: true, data: DEMO_DETAIL });
    expect(h.requireActionMember).toHaveBeenLastCalledWith("operator");
  });
  it("keeps start, stop and restart for the owner", async () => {
    expect(await containerVerbAction(ID, "restart", "web")).toEqual({ ok: true, message: "web restarted." });
    expect(h.requireActionMember).toHaveBeenLastCalledWith("owner");
    expect(h.runContainerAction).toHaveBeenCalledWith(owner, ID, "restart", "web");
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await containerVerbAction(ID, "stop", "web")).ok).toBe(false);
    expect(h.runContainerAction).toHaveBeenCalledTimes(1);
  });
  it("refuses a verb or reference that isn't one before anything runs", async () => {
    expect((await containerVerbAction(ID, "remove" as never, "")).ok).toBe(false);
    expect((await containerVerbAction("../x", "start", "")).ok).toBe(false);
    expect((await containerDetailAction("a b")).ok).toBe(false);
    expect(h.runContainerAction).not.toHaveBeenCalled();
    expect(h.containerDetailFor).not.toHaveBeenCalled();
  });
  it("shows made-up containers in the demo and refuses actions there", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    expect(await containerListAction()).toEqual({ ok: true, data: { containers: DEMO_CONTAINERS } });
    expect(await containerDetailAction(ID)).toEqual({ ok: true, data: DEMO_DETAIL });
    expect(await containerVerbAction(ID, "restart", "web")).toEqual({ ok: false, error: "Container actions are off in the demo." });
    expect(h.loadContainers).not.toHaveBeenCalled();
    expect(h.runContainerAction).not.toHaveBeenCalled();
  });
});
