// The static HTML files in public/ that the console serves (no imports: next.config.ts reads this file too).
// The open source edition ships none, so every page gets the CSP with a nonce. Without a file there, a listed path would
// be a console page served the policy without a nonce (review T2b-fix3 I-1).
// OFFICE_FRAME_PATH stays (same exports in both editions): next.config.ts frames that path only when the file exists.
export const OFFICE_FRAME_PATH = "/office/kantor-virtual.html";
export const STATIC_HTML_PATHS: readonly string[] = [];
