import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, parseTemplates, renderTemplate, storedTemplate, type TemplateValues, templateProblem } from "./message-template";

const v: TemplateValues = {
  status: "FIRING", severity: "warning", rule: "VulnerableDependency", target: "orbit-blog", detail: "1 vulnerable package (1 high): zod 4.6.5 → 4.6.6.",
  cause: "", step: "", since: "03:08 WIB", threshold: "",
};

describe("message templates (1.2.4)", () => {
  it("accepts the known fields and names an unknown one", () => {
    expect(templateProblem(DEFAULT_TEMPLATE.id)).toBeNull();
    expect(templateProblem("{target} is down, see {dashboard}")).toMatch(/^\{dashboard\} isn't a field\. Use \{status\}/);
    expect(templateProblem("x".repeat(1001))).toBe("Keep it under 1,000 characters.");
    expect(templateProblem("plain words, a {} and {{ $value }} stay as they are")).toBeNull();
  });

  it("stores only a changed text: Watchbell's own (even with CRLF and trailing spaces) or an empty one is nothing", () => {
    expect(storedTemplate(DEFAULT_TEMPLATE.en, "en")).toBeNull();
    expect(storedTemplate(`${DEFAULT_TEMPLATE.id.replace(/\n/g, "  \r\n")}\n\n`, "id")).toBeNull();
    expect(storedTemplate("   ", "id")).toBeNull();
    expect(storedTemplate(42, "id")).toBeNull();
    expect(storedTemplate("  {target}: {detail}  \r\nRunbook: https://wiki.example.com/deps \n", "en")).toBe("{target}: {detail}\nRunbook: https://wiki.example.com/deps");
  });

  it("fills the fields and drops a line whose fields are all empty, never a line without fields", () => {
    const text = "{status} · {target}\n{detail}\n{cause}\nYang perlu kamu lakukan: {step}\n\nCek Dependabot dulu.\nsejak {since}";
    expect(renderTemplate(text, v)).toBe("FIRING · orbit-blog\n1 vulnerable package (1 high): zod 4.6.5 → 4.6.6.\n\nCek Dependabot dulu.\nsejak 03:08 WIB");
    expect(renderTemplate("{cause} / {step}\nkeep", v)).toBe("keep");
    expect(renderTemplate("{step} and {target}", v)).toBe("and orbit-blog");
  });

  it("leaves anything that isn't a field alone, prototype names included", () => {
    expect(renderTemplate("{constructor} {toString} {{target}}", v)).toBe("{constructor} {toString} {orbit-blog}");
  });

  it("reads the stored row defensively", () => {
    expect(parseTemplates(null)).toEqual({});
    expect(parseTemplates([1, 2])).toEqual({});
    expect(parseTemplates({ MonitorDown: { id: "{target} mati", en: 5, fr: "x" }, HighLatency: "nope", DatabasePaused: { en: "{nope}" } })).toEqual({ MonitorDown: { id: "{target} mati" } });
  });
});
