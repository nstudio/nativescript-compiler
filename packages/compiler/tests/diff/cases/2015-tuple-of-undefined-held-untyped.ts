// A one-element tuple of undefined held where an array of any value is declared is the same array, and holds whatever
// is written through either.
const one: [undefined] = [undefined];
console.log(typeof one[0], one.length, JSON.stringify(one));
const loose: any[] = one;
loose[0] = 'x';
loose.push(2);
console.log(JSON.stringify(one), one.length, one === loose, typeof loose[0]);

function nothing(): [void] {
  return [undefined];
}
const got: unknown[] = nothing();
got[0] = { a: 1 };
got.push(null);
console.log(JSON.stringify(got), got.length);

function fill(into: any[], value: unknown): void {
  into[0] = value;
}
const slot: [undefined] = [undefined];
fill(slot, 7);
console.log(JSON.stringify(slot), slot.length);

async function settle(): Promise<void> {
  const loads: any[] = [Promise.resolve()];
  const all = (await Promise.all(loads)) as [undefined];
  const seen: any[] = all;
  seen[0] = 'settled';
  console.log(JSON.stringify(all), all.length);
}
settle();
