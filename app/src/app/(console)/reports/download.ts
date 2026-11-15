// Watchbell 1.7.1 (review M-8): the report PDF is fetched in the page, so a refused download (rate limit, a month no
// longer kept, a PDF that couldn't be made) shows the server's reason instead of a browser download that just fails.

export type FetchedPdf = { ok: true; blob: Blob; filename: string } | { ok: false; error: string };

export function fileNameFrom(contentDisposition: string | null, fallback: string): string {
  return /filename="([^"]+)"/.exec(contentDisposition ?? "")?.[1] ?? fallback;
}

export async function fetchReportPdf(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedPdf> {
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: "same-origin" });
  } catch {
    return { ok: false, error: "The download didn't reach the server. Check your connection and try again." };
  }
  if (!res.ok) {
    // The route answers plain text; anything else (a proxy's or the host's error page) is never shown as the reason.
    const plain = (res.headers.get("content-type") ?? "text/plain").startsWith("text/plain");
    const text = plain ? (await res.text().catch(() => "")).trim() : "";
    return { ok: false, error: text && text.length <= 300 ? text : `The download failed (${res.status}). Try again in a moment.` };
  }
  return { ok: true, blob: await res.blob(), filename: fileNameFrom(res.headers.get("content-disposition"), "report.pdf") };
}

// Saves the PDF the way a download link would.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
