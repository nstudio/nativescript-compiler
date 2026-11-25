// @app-lenient
// @cli-program
// A non-strict app's strings and numbers that hold undefined outside any container: a destructured piece past the end,
// a regular expression's group that took no part, a character past the end and a list's popped value. Each is bound,
// compared, switched on and passed on as undefined, and a member read or method call of it is JavaScript's TypeError.
function attempt(label: string, f: () => unknown) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}
function describe(s: string): string {
  return s === undefined ? 'U' : typeof s + ':' + s;
}
function kind(mark: string): string {
  switch (mark) {
    case 'undefined':
      return 'text';
    case 'D':
      return 'down';
    default:
      return 'other';
  }
}
const [first, second] = 'Am'.split(' ');
console.log(describe(first), describe(second), second === 'undefined', second === undefined, kind(second));
attempt('trim', () => second.trim());
attempt('length', () => second.length);

const grid = 'D.';
for (let slot = 0; slot <= grid.length; slot++) {
  const mark = grid[slot];
  console.log(slot, describe(mark), mark === 'undefined', kind(mark), mark === '.' ? 'rest' : 'beat');
}

const linked = 'see [docs][] and [api][ref]'.replace(/\[([^\]]+)\]\[([^\]]*)\]|\[(\w+)\]/g, (raw: string, label: string, ref: string) => {
  return '<' + describe(ref) + '|' + (ref || label) + '>';
});
console.log(linked);
const odd = 'x1'.replace(/(x)(y)?(\d)/, (all: string, x: string, y: string, d: string) => describe(y) + d);
console.log(odd);

const zone = (z: string): number => {
  const m = /^([+-])(\d{2})?$/.exec(z);
  if (!m) return 0;
  const digits = m[2];
  attempt('digits', () => digits.slice(0, 1));
  return digits === undefined ? -1 : Number(digits);
};
console.log(zone('+'), zone('+05'));

const lines: string[] = [];
const last = lines.pop();
attempt('last', () => last.length);
console.log(describe(last), last === 'undefined');
let saved = 'start';
function keep(v: string) {
  saved = v;
}
keep(second);
console.log(describe(saved));
