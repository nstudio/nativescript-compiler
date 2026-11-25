// Arrays that start empty and untyped (`const xs = []`), filled, then given where a typed array goes.
interface Span { start: number; end: number }

function spans(n: number): Span[] {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ start: i * 7, end: i * 7 + 6 });
  return out;
}

const labels = (days: string[]): { day: string; short: string }[] => {
  const result = [];
  for (const d of days) result.push({ day: d, short: d.substring(0, 2) });
  return result;
};

function total(xs: Span[]): number {
  return xs.reduce((s, x) => s + (x.end - x.start), 0);
}

const made = [];
made.push({ start: 1, end: 4 });
console.log(JSON.stringify(spans(3)), JSON.stringify(labels(['Monday', 'Tuesday'])), total(made), total(spans(2)));
