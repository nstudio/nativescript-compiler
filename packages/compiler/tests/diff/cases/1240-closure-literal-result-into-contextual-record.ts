// Object literals returned by callbacks whose slot's result is a declared interface or object type.
interface Point { index: number; value: number }

function averages(groups: Map<number, number[]>): Point[] {
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, values]) => ({ index, value: values.reduce((t, v) => t + v, 0) / values.length }));
}

function byYear(groups: Record<string, string[]>): { year: number; items: string[] }[] {
  return Object.keys(groups)
    .sort((a, b) => Number(b) - Number(a))
    .map((year) => ({ year: Number(year), items: groups[year].sort() }));
}

const groups = new Map<number, number[]>([[2, [4, 6]], [1, [1, 2, 3]]]);
for (const p of averages(groups)) console.log(p.index, p.value);
console.log(JSON.stringify(byYear({ '2020': ['b', 'a'], '2021': ['c'] })));

const points: Point[] = [7, 9].map((v, i) => ({ index: i, value: v * 2 }));
function memo<T>(fn: () => T): () => T { return () => fn(); }
class Report {
  readonly trend = memo<Point[]>(() => [3, 1].sort((a, b) => a - b).map((v) => ({ index: v, value: v / 2 })));
}
console.log(JSON.stringify(points), JSON.stringify(new Report().trend()));
