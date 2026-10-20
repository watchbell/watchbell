"use client";

import { IconDownload } from "@tabler/icons-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { exportLogsCsv } from "./actions";
import type { SearchParams } from "./filter";

// Asks the server for the CSV of the current filter and saves it from the browser (a Blob; nothing is stored anywhere).
export function ExportButton({ params }: { params: SearchParams }) {
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    try {
      const r = await exportLogsCsv(params);
      if (!r.ok || !r.data) { toast.error(r.ok ? "Nothing to export." : r.error); return; }
      const url = URL.createObjectURL(new Blob(["﻿", r.data.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `watchbell-ai-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(r.message ?? "Exported.");
    } catch {
      toast.error("Something went wrong. Try again.");
    }
  });
  return <Button onClick={run} disabled={pending}><IconDownload size={16} aria-hidden />{pending ? "Exporting..." : "Export CSV"}</Button>;
}
