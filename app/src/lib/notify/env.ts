import "server-only";

// Spec §13. Optional: a missing value turns its channel off with a message on the Notifications tab, nothing else.
export function notifyEnv(source: Record<string, string | undefined> = process.env) {
  const t = source.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const r = source.RESEND_API_KEY?.trim() ?? "";
  const f = source.DIGEST_FROM?.trim() ?? "";
  return {
    telegramToken: /^\d+:[\w-]{20,}$/.test(t) ? t : null,
    resendKey: r.startsWith("re_") ? r : null,
    digestFrom: /<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(f) ? f : null,
  };
}
