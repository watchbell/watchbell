// The mockup's `.scope`: a small mono tag per scope. Plain markup, usable from server and client components.
export function ScopeChips({ scopes }: { scopes: readonly string[] }) {
  return (
    <>
      {scopes.map((s) => (
        <span key={s} className="mr-1 inline-block whitespace-nowrap rounded-[4px] border border-line bg-surface-2 px-[5px] font-mono text-xs text-ink-soft">{s}</span>
      ))}
    </>
  );
}
