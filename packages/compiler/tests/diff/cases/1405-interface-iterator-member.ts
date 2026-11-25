// An interface with a well-known symbol's member, its object made as a literal and iterated as JavaScript steps it.
interface Range {
  from: number;
  to: number;
  [Symbol.iterator](): Iterator<number>;
}

function range(from: number, to: number): Range {
  return {
    from,
    to,
    [Symbol.iterator]() {
      let i = this.from;
      const end = this.to;
      return { next: () => (i <= end ? { value: i++, done: false } : { value: undefined, done: true }) };
    },
  };
}

const r = range(2, 5);
const out: number[] = [];
for (const v of r) out.push(v);
console.log(out.join(','), Object.keys(r).join(','), JSON.stringify(r));
r.to = 3;
console.log([...r].join(','));
