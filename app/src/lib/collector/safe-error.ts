// Text that is safe to store in collector_runs.error_summary. Drizzle wraps the real database error: its message is
// "Failed query: <sql>" (params on later lines) and the driver's message is the `cause`. So use the cause when there
// is one, keep only the first line, mask any bearer token and cap the length. Adapter errors are already written
// without credentials.
export function safeError(e: unknown): string {
  const source = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  const text = (source instanceof Error ? source.message : "").split("\n")[0].replace(/Bearer\s+\S+/gi, "Bearer [hidden]").trim() || "failed";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// The cause on a warn line of the selfhost scheduler and Telegram poller: safeError, plus a Telegram bot token
// (api.telegram.org/bot<token>/...) and the user:password of a connection URL hidden.
export function logCause(e: unknown): string {
  return safeError(e).replace(/\bbot\d+:[\w-]+/g, "bot[hidden]").replace(/\/\/[^/\s@]+@/g, "//[hidden]@");
}
