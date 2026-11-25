// @app-lenient
// A non-strict app reading a member of, and calling a function field of, what a library call gives: `find`'s result
// is undefined where nothing matches, whose member reads undefined only through `?.`, and a plain read or call throws.
interface Rule {
  kind: string;
  handler: (n: number) => number;
}

const rules: Rule[] = [
  { kind: 'double', handler: (n) => n * 2 },
  { kind: 'square', handler: (n) => n * n },
];

function apply(kind: string, n: number): number {
  return rules.find((r) => r.kind === kind).handler(n);
}

function kindOf(kind: string): string {
  return rules.find((r) => r.kind === kind).kind;
}

console.log(apply('double', 3), apply('square', 4), kindOf('square'));
for (const run of [() => apply('cube', 2), () => kindOf('cube')]) {
  try {
    console.log(run());
  } catch (e) {
    console.log(e instanceof TypeError);
  }
}
const found = rules.find((r) => r.kind === 'none');
console.log(found?.kind, typeof found);
