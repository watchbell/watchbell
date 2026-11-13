// Links and labels shared by the Next.js Security card and the OS vulnerabilities page.

export const nvdUrl = (cve: string): string | null =>
  /^CVE-\d{4}-\d{4,}$/.test(cve) ? `https://nvd.nist.gov/vuln/detail/${cve}` : null;

export const cvssText = (score: number | null | undefined): string | null =>
  typeof score === "number" && Number.isFinite(score) ? score.toFixed(1) : null;
