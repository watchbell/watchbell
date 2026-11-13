// Owner 13 Nov: the bottom of the sidebar names the Watchbell this console runs, linked to its CHANGELOG section, so an
// update shows on the console itself (the cloud edition included). Rendered by the client sidebar, so the server
// layout hands over the link (null in the demo, where nothing links out: lib/demo/links.ts).
export type ConsoleVersion = { text: string; href: string | null };

export function VersionLabel({ version }: { version: ConsoleVersion | null }) {
  if (!version) return null;
  const label = `Watchbell ${version.text}`;
  return (
    <div className="px-3 pb-2 text-[11.5px] text-ink-faint">
      {version.href
        ? <a href={version.href} target="_blank" rel="noopener" className="hover:text-ink-soft hover:underline">{label}</a>
        : <span>{label}</span>}
    </div>
  );
}
