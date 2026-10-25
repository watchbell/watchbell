// 1.2.1 (UI audit P6): an unknown or unpublished slug. Visitors are strangers to the console, so this page has no links
// into it, no data and no script: plain words in the status page's own frame.
export default function StatusPageNotFound() {
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-1.5 px-4 pb-12 pt-8">
      <h1 className="text-[20px]">No status page here</h1>
      <p className="m-0 text-ink-soft">
        This address doesn&apos;t match a published status page. Check the link with whoever sent it.
      </p>
    </main>
  );
}
