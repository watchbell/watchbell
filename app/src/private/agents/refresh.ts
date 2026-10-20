// The Agents page re-reads its data every 15 s while the tab is visible (the mockup's "Listening" row). Pure decision,
// so it is tested without a browser: not while the tab is hidden, offline, or a dialog or menu holds the page.
export const AGENTS_REFRESH_MS = 15_000;

export function agentsRefreshDue(s: { visible: boolean; online: boolean; held: boolean }): boolean {
  return s.visible && s.online && !s.held;
}
