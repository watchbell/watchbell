import "server-only";
import { mapLimit } from "@/lib/collector/http-check";
import { targets } from "@/lib/data/logs-db";
import { mergeSnapshot } from "@/lib/data/snapshots-db";
import { readPageViews } from "@/lib/providers/vercel-analytics";
import { storedPageViews } from "@/lib/view/pageviews";

const HOUR = 3_600_000;
// The window is the 23 whole hours before this one plus the hour so far: at most 24 hourly buckets, aligned to Vercel's.
const WINDOW_HOURS = 24;
// The reader's own timeout is 8 s; skip an app when less than that (plus a margin) remains. Same as MIN_LEFT_MS.pageviews.
const READ_MARGIN_MS = 8500;

// The `pageviews` task: each watched app's page views of the last 24 h from Vercel Web Analytics (free on Hobby), merged into
// ops.snapshots.data as `pageviews` (jsonb ||, so `state` and the other keys stay as they are). A read that fails keeps the last
// good value and adds one line to `errors`; a project without Web Analytics is a good answer ({ enabled: false }). App
// snapshots aren't cached (apps are real-time), so there is no tag to expire. 3 apps at a time, two calls each.
export async function taskPageViews(now: Date, deadline: number, errors: string[]): Promise<void> {
  const list = await targets(null);
  if (!list.length) return;
  const until = now;
  const since = new Date(Math.floor(now.getTime() / HOUR) * HOUR - (WINDOW_HOURS - 1) * HOUR);
  await mapLimit(list, 3, async (t) => {
    if (Date.now() + READ_MARGIN_MS > deadline) return;
    const r = await readPageViews(t.token, t.teamId, t.projectId, { since, until });
    if (!r.ok) {
      errors.push(`pageviews/${t.appName}: ${r.error}`);
      return;
    }
    try {
      await mergeSnapshot(t.appId, { pageviews: storedPageViews(r, now) }, now);
    } catch {
      errors.push(`pageviews/${t.appName}: couldn't save the page views`);
    }
  });
}
