import type { State } from "@/lib/status";

// 1.2.3 (UI audit C2): one sentence under the Overview title that answers "is everything OK?", from what the page
// already loaded: the watched apps' states and the banners it shows below. Null when no app is watched yet (the
// Applications card says how to start). "Up" counts ok and building; down is err/fail; degraded is warn.
export function overviewSummary(apps: State[], needs: number): string | null {
  if (!apps.length) return null;
  const n = apps.length;
  const down = apps.filter((s) => s === "err" || s === "fail").length;
  const degraded = apps.filter((s) => s === "warn").length;
  const up = apps.filter((s) => s === "ok" || s === "build").length;
  const word = (k: number) => (k === 1 ? "app" : "apps");
  const first = !down && !degraded && up === n
    ? n === 1 ? "The app is up." : n === 2 ? "Both apps are up." : `All ${n} apps are up.`
    : `${up} of ${n} ${word(n)} ${up === 1 ? "is" : "are"} up${down ? `, ${down} down` : ""}${degraded ? `, ${degraded} degraded` : ""}.`;
  const second = needs ? `${needs} ${needs === 1 ? "thing needs" : "things need"} you; ${needs === 1 ? "it is" : "they are"} below.` : "Nothing needs you.";
  return `${first} ${second}`;
}
