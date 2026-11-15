import { AuthError } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { getReport } from "@/lib/data/report-db";
import { makeReportPdf } from "@/lib/report/make";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { timeZone } from "@/lib/time";

// Watchbell 1.7 (spec §2.2): the monthly report as a PDF download, for every member (viewers too). The PDF is made on
// request only, so the CPU cost is one render per download, and a burst is slowed down.

const plain = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
const AUTH_STATUS: Record<string, number> = { "signed-out": 401, "not-member": 403, forbidden: 403, mfa: 401, "password-change": 403 };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let member;
  try {
    member = await requireActionMember("viewer");
  } catch (e) {
    if (e instanceof AuthError) return plain(AUTH_STATUS[e.reason] ?? 401, "Sign in to download this report.");
    throw e;
  }
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const month = q.get("month") ?? "";
  const langParam = q.get("lang");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return plain(400, "That isn't a month (YYYY-MM).");
  if (langParam !== null && langParam !== "id" && langParam !== "en") return plain(400, "The language is id or en.");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return plain(404, "There's no such report.");
  const report = await getReport(id);
  if (!report) return plain(404, "There's no such report.");
  const quota = await limit(LIMITS.reportPdf, member.id);
  if (!quota.allowed) return plain(429, `Too many downloads. Try again in ${minutesText(quota.retryAfter)}.`);

  const lang = (langParam as "id" | "en" | null) ?? report.lang;
  const made = await makeReportPdf(id, month, new Date(), timeZone(), lang);
  if ("error" in made) {
    if (made.error === "not-found") return plain(404, "There's no such report.");
    if (made.error === "no-sites") return plain(422, "This report has no websites. Add one on the Reports page first.");
    if (made.error === "render-failed") return plain(500, "The PDF couldn't be made. The error is in the server log.");
    return plain(422, "That month's data is no longer kept (Settings › Retention). Pick a newer month.");
  }
  return new Response(made.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${made.filename}"`, "cache-control": "private, no-store" },
  });
}
