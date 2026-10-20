import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordContent } from "./record-content";

describe("RecordContent", () => {
  it("cuts a long TXT value with an ellipsis and keeps the whole value in the tooltip", () => {
    const key = `v=DKIM1; k=rsa; p=${"MIGfMA0GCSqGSIb3DQEB".repeat(20)}`;
    const out = renderToStaticMarkup(h(RecordContent, { value: key }));
    expect(out).toContain("truncate");
    expect(out).toContain("max-w-");
    expect(out).toContain(`title="${key}"`);
  });
});
