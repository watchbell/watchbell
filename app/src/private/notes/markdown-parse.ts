// The safe markdown subset for text written by agents (R8: notes, Antigravity answers): paragraphs, "#" headings (shown
// as a bold line), "-"/"*" and "1." lists, ``` code blocks, **bold**, `code`, and links shown as text. There is no raw
// HTML and no anchor: the parser only builds a tree; markdown.tsx renders it with React's escaping.

export type Inline = { t: "text" | "b" | "code"; text: string };
export type Block =
  | { t: "p"; inl: Inline[] }
  | { t: "h"; inl: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "code"; text: string };

export const MARKDOWN_MAX = 8000;

const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  for (const part of src.split(TOKEN)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ t: "b", text: part.slice(2, -2) });
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push({ t: "code", text: part.slice(1, -1) });
    else {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      // A link is only text: the label, plus the address when it is http(s). Never clickable.
      if (m) out.push({ t: "text", text: /^https?:\/\//i.test(m[2]) ? `${m[1]} (${m[2]})` : m[1] });
      else out.push({ t: "text", text: part });
    }
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.slice(0, MARKDOWN_MAX).replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inl: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    if (h) { flush(); blocks.push({ t: "h", inl: parseInline(h[1].trim()) }); continue; }
    const li = /^\s*([-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      flush();
      const kind: "ol" | "ul" = /\d/.test(li[1]) ? "ol" : "ul";
      const last = blocks[blocks.length - 1];
      const item = parseInline(li[2].trim());
      if (last && (last.t === "ul" || last.t === "ol") && last.t === kind) last.items.push(item);
      else blocks.push({ t: kind, items: [item] });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
