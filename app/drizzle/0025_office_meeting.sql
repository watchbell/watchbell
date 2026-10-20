-- Kantor Virtual morning meeting (owner 15 Oct): every WIB day at/after 10:00 the minute collector runs one patrol and
-- stores its report in the inbox as source 'meeting' ("Rapat pagi <date>"). The meeting's own office events are ev
-- 'patrol' rows with agent 'meeting' (office_events.agent has no value check, so only the reports' source check widens).
-- Additive: every existing row already passes the new check.
alter table ops.office_reports drop constraint if exists office_reports_source_check;--> statement-breakpoint
alter table ops.office_reports add constraint office_reports_source_check check (source in ('patrol', 'manager', 'meeting'));
