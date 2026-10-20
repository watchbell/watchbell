// Demo mode: one slim line at the top of every console page (the (console) layout passes `demo` to the Shell).
export const DEMO_BANNER_TEXT = "Demo — data is made up and resets.";
// A visitor's database lives in one server's memory: a restart (or a quiet spell) re-creates it from scratch.
export const DEMO_BANNER_RESET_TEXT = "Results of your actions can disappear when the demo restarts.";

export function DemoBanner() {
  return (
    <div role="note" className="border-b border-line bg-brand-soft px-6 py-1.5 text-[12.5px] text-nav-active-text max-[720px]:px-3.5">
      {`${DEMO_BANNER_TEXT} ${DEMO_BANNER_RESET_TEXT}`}
    </div>
  );
}
