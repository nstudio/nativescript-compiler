// An array of undefined held where an array of any value is declared is the same array, and holds whatever is written
// through either: a placeholder array filled later (rxjs's forkJoin collecting each source's last value), aliases of
// declared `undefined[]` and `void[]` arrays, and reads of its elements as undefined.
class Collect {
  constructor(private readonly sources: any[]) {}
  run(project: (values: any[]) => unknown): unknown {
    const values: any[] = this.sources.map(() => undefined);
    const has: boolean[] = this.sources.map(() => false);
    this.sources.forEach((source, index) => {
      values[index] = source;
      has[index] = true;
    });
    return has.every((h) => h) ? project(values) : 'incomplete';
  }
}
const merged = new Collect([{ odd: true }, null, { big: true }]).run((values) => {
  const res: { [key: string]: unknown } = {};
  for (const errors of values) if (errors != null) for (const key of Object.keys(errors)) res[key] = errors[key];
  return res;
});
console.log(JSON.stringify(merged));

const sources: unknown[] = ['a', 'b'];
const u = sources.map(() => undefined);
console.log(JSON.stringify(u), u.length, String(u[0]), u[1] === undefined);
const v: any[] = u;
v[0] = { x: 1 };
v.push('three');
console.log(JSON.stringify(u), u === v, u.length);

const decl: undefined[] = [undefined, undefined];
const loose: unknown[] = decl;
loose[1] = 2;
loose.push(3);
console.log(decl.length, JSON.stringify(decl), decl.indexOf(undefined));

function voids(): void[] {
  return [undefined];
}
const vv: any[] = voids();
vv[0] = 'set';
console.log(JSON.stringify(vv), typeof vv[0]);
const filled: any[] = new Array<undefined>(2).fill(undefined);
filled[0] = [1];
console.log(JSON.stringify(filled));

function nothing(_x: number): undefined {
  return undefined;
}
const byReference: any[] = [1, 2].map(nothing);
byReference[1] = 'b';
const blocks = [1, 2].map((n) => {
  if (n > 5) console.log('never');
});
const blocksLoose: unknown[] = blocks;
blocksLoose[0] = true;
const fromMapper: any[] = Array.from({ length: 2 }, () => undefined);
fromMapper[1] = 9;
console.log(JSON.stringify(byReference), JSON.stringify(blocks), JSON.stringify(fromMapper), blocks === blocksLoose);
