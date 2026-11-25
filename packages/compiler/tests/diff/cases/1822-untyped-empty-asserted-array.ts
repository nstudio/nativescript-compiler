// An untyped value asserted to an array converts nothing: a null match stays null, and reading its elements, length or
// methods is JavaScript's TypeError.
const t = (f: () => unknown, k: string) => {
  try {
    console.log(k, f());
  } catch (e) {
    console.log(k, 'caught', e instanceof TypeError);
  }
};
const u: unknown = 'abc'.match(/x/);
const m: any = 'abc'.match(/x/);
t(() => m[0], 'any');
t(() => (u as string[])[0], 'element');
t(() => (u as number[]).length, 'length');
t(() => (u as any[]).map((x) => x), 'method');
t(() => {
  const a = u as string[];
  console.log('held');
  return a.length;
}, 'held');
t(() => {
  const a = u as string[];
  return a ? 'yes' : 'no';
}, 'truthy');
t(() => {
  const a: string[] | null = u as string[];
  return a === null;
}, 'null');
class V {
  n = 2;
}
t(() => (u as V[])[0].n, 'class element');
const found: unknown = [new V()];
t(() => (found as V[])[0].n, 'present');
t(() => (['x'] as unknown as string[])[0], 'literal');
