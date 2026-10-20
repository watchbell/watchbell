"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { forgetAgent, renameAgent } from "./agents-db";
import { DISPLAY_NAME_RE } from "./detect";

// R2: the owner's alone, checked again on the server.
const deps = { requireActionMember };

const GONE = "That agent is already gone. It reappears with its next request.";

export async function renameAgentAction(id: unknown, name: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const agentId = z.uuid().safeParse(id);
    if (!agentId.success) return { ok: false, error: GONE };
    const display = z.string().trim().regex(DISPLAY_NAME_RE).safeParse(name);
    if (!display.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { name: "Use up to 40 letters, digits, spaces, dots, dashes or underscores." } };
    if (!(await renameAgent(agentId.data, display.data, actor.id))) return { ok: false, error: GONE };
    revalidatePath("/ai/agents");
    return { ok: true, message: display.data ? "Agent renamed." : "Agent name reset." };
  }, deps, "local");
}

export async function forgetAgentAction(id: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const agentId = z.uuid().safeParse(id);
    if (!agentId.success) return { ok: false, error: GONE };
    if (!(await forgetAgent(agentId.data, actor.id))) return { ok: false, error: GONE };
    revalidatePath("/ai/agents");
    return { ok: true, message: "Agent forgotten. It reappears with its next request." };
  }, deps, "local");
}
