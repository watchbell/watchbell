import { Card, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { requirePageMember } from "@/lib/auth";
import { aliasBook } from "@/lib/data/cached";
import { listEvents } from "@/lib/data/events-db";
import { repeatText } from "@/lib/events/reasons";
import { hideEvent } from "@/lib/view/display-name";
import { eventTime } from "@/lib/view/format";
import { EVENT_TYPE_LABEL } from "@/lib/view/labels";
import { EventFeed, type FeedEvent } from "./event-feed";

export default async function EventsPage() {
  await requirePageMember();
  const now = new Date();
  const [rows, book] = await Promise.all([listEvents(), aliasBook()]);
  // Privacy: a database's events by its alias, no names or emails in the text, stored rows included.
  const events: FeedEvent[] = rows.map((r) => hideEvent(r, book)).map((e) => ({
    id: e.id, iso: (e.lastAt ?? e.at).toISOString(), time: eventTime(e.lastAt ?? e.at, now), kind: e.kind, type: e.type,
    typeLabel: EVENT_TYPE_LABEL[e.type] ?? e.type, resource: e.resource, message: e.message, detail: e.detail,
    repeat: repeatText(e.count, e.lastAt, now), reason: e.reason,
  }));
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader crumbs={[{ label: "Home" }, { label: "Events" }]} title="Events" sub="Changes the collector noticed. New ones appear while this page is open. A change that repeats within an hour is counted on one row." />
      <Card><EventFeed events={events} /></Card>
    </>
  );
}
