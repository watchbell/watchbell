"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { containerDetailFor, type ListedContainer, loadContainers, runContainerAction } from "@/lib/data/docker-db";
import type { ContainerDetail, ContainerVerb } from "@/lib/docker/client";
import { DEMO_CONTAINERS, DEMO_DETAIL } from "@/lib/docker/demo";
import { isContainerRef } from "@/lib/docker/parse";
import { INVALID } from "@/lib/provider-actions";

// Watchbell 1.5 DevOps › Containers (self-host only). Reading the list and a container's detail is Operator+; start, stop
// and restart are the owner's (docker-db audits them). Demo: made-up containers, actions refused.

const VERBS = new Set<ContainerVerb>(["start", "stop", "restart"]);

export async function containerListAction(): Promise<ActionResult<{ containers: ListedContainer[] }>> {
  return runGuarded("operator", async () => {
    const r = await loadContainers();
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => ({ ok: true, data: { containers: DEMO_CONTAINERS } }));
}

export async function containerDetailAction(id: string): Promise<ActionResult<ContainerDetail>> {
  return runGuarded<ContainerDetail>("operator", async () => {
    if (!isContainerRef(id)) return { ok: false, error: INVALID };
    const r = await containerDetailFor(id);
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => (isContainerRef(id) ? { ok: true, data: DEMO_DETAIL } : { ok: false, error: INVALID }));
}

export async function containerVerbAction(id: string, verb: ContainerVerb, typedName: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!isContainerRef(id) || !VERBS.has(verb) || typeof typedName !== "string" || typedName.length > 128) return { ok: false, error: INVALID };
    const r = await runContainerAction(member, id, verb, typedName);
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => ({ ok: false, error: "Container actions are off in the demo." }));
}
