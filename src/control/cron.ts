// Minimal deterministic 5-field cron (UTC): minute hour day-of-month month day-of-week.
// Supports *, lists (a,b), ranges (a-b), steps (*/n, a-b/n). Standard dom/dow OR semantics.

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

export interface Cron { sets: Set<number>[]; domStar: boolean; dowStar: boolean }

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields: '${expr}'`);
  const sets = parts.map((p, i) => parseField(p, FIELDS[i].min, FIELDS[i].max, expr));
  // Sunday as 7 is accepted and folded to 0.
  if (sets[4].has(7)) { sets[4].delete(7); sets[4].add(0); }
  return { sets, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

function parseField(field: string, min: number, max: number, expr: string): Set<number> {
  const out = new Set<number>();
  const hi = max === 6 ? 7 : max;
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad cron field '${field}' in '${expr}'`);
    let [a, b] = m[1] === "*" ? [min, max] : m[1].split("-").map(Number) as [number, number?];
    if (b === undefined) b = m[2] ? max : a;
    const step = m[2] ? Number(m[2]) : 1;
    if (a < min || b! > hi || a > b! || step < 1) throw new Error(`cron field out of range '${field}' in '${expr}'`);
    for (let v = a; v <= b!; v += step) out.add(v);
  }
  return out;
}

function matches(c: Cron, d: Date): boolean {
  const [mi, h, dom, mo, dow] = c.sets;
  if (!mi.has(d.getUTCMinutes()) || !h.has(d.getUTCHours()) || !mo.has(d.getUTCMonth() + 1)) return false;
  const domOk = dom.has(d.getUTCDate());
  const dowOk = dow.has(d.getUTCDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

/** First fire time strictly after `after` (ms epoch), at minute resolution. */
export function nextFire(expr: string | Cron, after: number): number {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = t + 366 * 24 * 60 * 60_000 * 5;
  while (t < limit) {
    if (matches(c, new Date(t))) return t;
    t += 60_000;
  }
  throw new Error("cron never fires");
}
