"use client";

import { IconPlus } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { buttonClass, Card, Tag } from "@/components/kit";
import { cn } from "@/lib/utils";
import { CONNECT_COPY } from "@/lib/copy/edition";
import { CodeTabs, PromptBox } from "@/private/ui/code-tabs";
import { automationPrompt, mcpConfigs, mcpUrl, MCP_TOOLS, originChoices, pickOrigin, questionsPrompt } from "@/private/ui/snippets";
import { scope, stepBox, stepNo } from "./connect-classes";
import { AgentAppNote, ServerCard } from "./connect-edition";

export type SeenAgent = { name: string; key: string | null; ago: string };

// "Connect an agent": the page the owner will use most. The server URL toggle switches every snippet and prompt between
// the local dev server and production; nothing else changes. The page never shows a real key (wb_YOUR_KEY stands in).
export function ConnectView({ siteUrl, seen }: { siteUrl: string; seen: SeenAgent[] }) {
  const choices = originChoices(siteUrl);
  const [pickId, setPickId] = useState(() => pickOrigin(choices, siteUrl).id);
  const [prompt, setPrompt] = useState<"daily" | "questions">("daily");
  const origin = (choices.find((c) => c.id === pickId) ?? choices[0]).origin;
  const readOnly = MCP_TOOLS.filter((t) => !t.write).length;
  const writes = MCP_TOOLS.length - readOnly;

  return (
    <>
    <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card title="Connect over MCP" meta="Streamable HTTP · read-only">
        <ol className="m-0 list-none p-0">
          <li className={stepBox}>
            <span className={stepNo}>1</span>
            <div>
              <h3 className="mb-1 mt-0.5 text-[14px] font-medium">Create a key with read:status</h3>
              <p className="mb-2 text-[13px] text-ink-soft">
                One key per agent. Add <span className={scope}>write:notes</span> for an agent that should post notes or answer questions
                ({CONNECT_COPY.automationsBelow}), and <span className={scope}>ai:invoke</span> only if it should also use your provider models through Watchbell.
              </p>
              <Link href="/ai/keys" className={buttonClass({ size: "sm" })}><IconPlus size={15} aria-hidden />Create key</Link>
            </div>
          </li>
          <li className={stepBox}>
            <span className={stepNo}>2</span>
            <div className="min-w-0">
              <h3 className="mb-1 mt-0.5 text-[14px] font-medium">Add Watchbell as an MCP server</h3>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                <span className="text-ink-soft" id="origin-label">Server</span>
                <div role="radiogroup" aria-labelledby="origin-label" className="inline-flex overflow-hidden rounded-md border border-line-strong">
                  {choices.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={c.id === pickId}
                      onClick={() => setPickId(c.id)}
                      className={cn(
                        "px-2.5 py-1 text-[13px] hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                        c.id === pickId ? "bg-brand-soft font-medium text-brand" : "bg-surface text-ink-soft",
                      )}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-[12.5px] text-ink-soft">{mcpUrl(origin)}</span>
              </div>
              <p className="mb-1 text-[13px] text-ink-soft">
                Replace <span className="font-mono text-[12.5px]">wb_YOUR_KEY</span> with the key. Keep it in an environment variable where the agent supports it.
              </p>
              <CodeTabs tabs={mcpConfigs(origin)} label="Agent configuration" />
              <AgentAppNote />
            </div>
          </li>
          <li className={stepBox}>
            <span className={stepNo}>3</span>
            <div className="min-w-0">
              <h3 className="mb-1 mt-0.5 text-[14px] font-medium">Ask the agent something</h3>
              <p className="mb-2 text-[13px] text-ink-soft">
                For example &quot;Which of my apps are down, and why?&quot;. The agent appears under <Link href="/ai/agents">Agents</Link> with its own name within a minute.
              </p>
              <div className="flex items-start gap-2.5 rounded-md border border-dashed border-line-strong px-3.5 py-3 text-[13px] text-ink-soft" role="status">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", seen.length ? "bg-ok" : "animate-pulse bg-ink-faint")} aria-hidden />
                {seen.length === 0 ? (
                  <span>Waiting for a new agent on a key with read:status. Reload this page after the first request.</span>
                ) : (
                  <span>
                    Seen over MCP in the last 24 hours:{" "}
                    {seen.map((a, i) => (
                      <span key={`${a.name}-${i}`}>{i > 0 && ", "}<b className="font-medium text-ink">{a.name}</b>{a.key ? ` (key ${a.key})` : ""}, {a.ago}</span>
                    ))}
                    . <Link href="/ai/agents">Open Agents</Link>
                  </span>
                )}
              </div>
            </div>
          </li>
        </ol>
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        <Card title="Tools the agent gets" meta={`${readOnly} read-only · ${writes} write with write:notes`} flush>
          <div className="px-[18px] pb-3">
            {MCP_TOOLS.map((t) => (
              <div key={t.name} className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-b-0">
                <span className="font-mono text-[12.5px]">{t.name}{t.write && <Tag>write</Tag>}</span>
                <span className="text-right text-[12.5px] text-ink-soft">{t.what}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title={CONNECT_COPY.automationTitle}>
          <p className="mb-2 text-[13px] text-ink-soft">
            {CONNECT_COPY.automationLead} Give its key{" "}
            <span className={scope}>read:status</span> <span className={scope}>write:notes</span>. Gemini models only: the prompt names <span className="font-mono text-[12.5px]">gemini-3.8-flash</span> and Watchbell rejects other models.
          </p>
          <div role="tablist" aria-label="Automation prompts" className="mb-2 inline-flex overflow-hidden rounded-md border border-line-strong">
            {([["daily", "Daily check"], ["questions", "Answer questions"]] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={prompt === id}
                onClick={() => setPrompt(id)}
                className={cn("px-2.5 py-1 text-[13px] hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40", prompt === id ? "bg-brand-soft font-medium text-brand" : "bg-surface text-ink-soft")}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mb-2 text-[12.5px] text-ink-soft">
            {prompt === "daily"
              ? "Every morning: finds apps that aren't running and posts one note per app. Notes show on Overview and on the app page."
              : "Answers the questions you ask with Ask AI in the console (they wait in the inbox until the agent runs)."}
          </p>
          <PromptBox
            text={prompt === "daily" ? automationPrompt(origin) : questionsPrompt(origin)}
            what={prompt === "daily" ? "Daily check prompt copied." : "Question prompt copied."}
          />
        </Card>

        <Card title="What agents can't do">
          <p className="m-0 text-[13px] text-ink-soft">
            No writes except AI notes and answers (with write:notes), no redeploys, no credentials. Results go through the same privacy rules as the console&apos;s screenshot
            mode: database names are aliases, emails hidden, logs scrubbed. Each tool call is rate-limited with the key&apos;s limit and logged as metadata.
          </p>
        </Card>

        <Card title="Not supported">
          <p className="m-0 text-[13px] text-ink-soft">
            {CONNECT_COPY.notSupportedLead} Watchbell only uses the API keys you connect under Bring your own key,
            one account per provider, never rotated. An agent&apos;s own subscription quota can&apos;t be read: there is no official API for it.
          </p>
        </Card>
      </div>
    </div>

    <ServerCard origin={origin} />
    </>
  );
}
