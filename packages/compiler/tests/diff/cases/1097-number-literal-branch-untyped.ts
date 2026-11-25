// A conditional with a number literal branch, held untyped: the literal is a number, whatever the other branch is.
const far = (globalThis as any).__far === 1;
const some: number | undefined = far ? 3 : undefined;
const id = (v: any) => v;
const show = (f: () => unknown) => {
  try {
    console.log(f());
  } catch (e) {
    console.log('threw', (e as Error).message);
  }
};
show(() => Number.prototype.valueOf.call(far ? 1 : 7) + 1);
show(() => Number.prototype.toString.call(far ? 1 : 255, 16));
const held: any = far ? 1 : 7;
show(() => [typeof held, held === 7, held.toFixed(1)].join());
const list: any[] = [far ? 1 : 2, far ? 'two' : 3];
show(() => list.map((x) => x.toFixed(1)).join());
show(() => id(far ? some : 7).toFixed(1));
show(() => id(far ? 8 : some));
show(() => id(far ? null : 9).toFixed(1));
show(() => id(far ? 'x' : -4).toFixed(1));
show(() => id(far ? some : far ? 1 : 8).toFixed(1));
const nested: any = far ? 'x' : (far ? 2 : 10);
show(() => nested.toFixed(1));
const record: { [k: string]: any } = { n: far ? 1 : 5 };
show(() => record.n.toFixed(1));
const map = new Map<string, any>();
map.set('k', far ? 1 : 6);
show(() => map.get('k').toFixed(1));
