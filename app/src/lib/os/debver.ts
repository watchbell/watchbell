// Debian/Ubuntu package version comparison (Debian policy §5.6.12): [epoch:]upstream[-revision]. Each part compares
// alternately a non-digit run (letters before non-letters, "~" before everything, even the end) and a digit run
// (numerically). Negative: a < b; 0: equal; positive: a > b.

function split(v: string): [number, string, string] {
  let rest = v.trim();
  let epoch = 0;
  const c = rest.indexOf(":");
  if (c > 0 && /^\d+$/.test(rest.slice(0, c))) {
    epoch = Number(rest.slice(0, c));
    rest = rest.slice(c + 1);
  }
  const d = rest.lastIndexOf("-");
  return d >= 0 ? [epoch, rest.slice(0, d), rest.slice(d + 1)] : [epoch, rest, ""];
}

// Sort weight of one character in a non-digit run: "~" lowest, then the end of the run, letters, everything else.
function order(ch: string | undefined): number {
  if (ch === undefined) return 0;
  if (ch === "~") return -1;
  if (/[A-Za-z]/.test(ch)) return ch.charCodeAt(0);
  return ch.charCodeAt(0) + 256;
}

function comparePart(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    // Non-digit run.
    while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
      const ca = i < a.length && !/\d/.test(a[i]) ? a[i] : undefined;
      const cb = j < b.length && !/\d/.test(b[j]) ? b[j] : undefined;
      const d = order(ca) - order(cb);
      if (d !== 0) return d;
      if (ca !== undefined) i++;
      if (cb !== undefined) j++;
    }
    // Digit run, compared as a number (leading zeros ignored).
    let na = "";
    let nb = "";
    while (i < a.length && /\d/.test(a[i])) na += a[i++];
    while (j < b.length && /\d/.test(b[j])) nb += b[j++];
    na = na.replace(/^0+/, "");
    nb = nb.replace(/^0+/, "");
    if (na.length !== nb.length) return na.length - nb.length;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export function compareDeb(a: string, b: string): number {
  const [ea, ua, ra] = split(a);
  const [eb, ub, rb] = split(b);
  if (ea !== eb) return ea - eb;
  return comparePart(ua, ub) || comparePart(ra, rb);
}
