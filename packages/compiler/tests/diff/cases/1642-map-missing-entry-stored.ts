// A Map's entry for a key it doesn't hold, asserted present and stored in an array, a record and another Map typed to
// hold numbers: each holds undefined, which a later check sees as JavaScript does.
function attempt(label: string, f: () => unknown) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}
const ages = new Map<string, number>([['ann', 30]]);
const found: number[] = [];
for (const who of ['ann', 'bob']) found.push(ages.get(who)!);
console.log(found.length, found[1] === undefined, JSON.stringify(found));
const cache: Record<string, number> = {};
cache['bob'] = ages.get('bob')!;
console.log(cache['bob'] === undefined, 'bob' in cache, JSON.stringify(cache), Object.keys(cache).length);
if (!cache['bob']) console.log('bob missing');
const copy = new Map<string, number>();
copy.set('bob', ages.get('bob')!);
copy.set('ann', ages.get('ann')!);
console.log(copy.size, copy.has('bob'), copy.get('bob') === undefined, typeof copy.get('bob'), copy.get('ann'));
for (const [k, v] of copy) console.log('copy', k, v === undefined ? 'U' : v);
attempt('fixed', () => copy.get('bob')!.toFixed(1));
attempt('ok', () => copy.get('ann')!.toFixed(1));
