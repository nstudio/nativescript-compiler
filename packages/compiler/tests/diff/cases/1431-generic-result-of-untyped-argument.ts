// A parameter given an untyped argument, passed to a generic function whose result is stored typed: the result is
// the very object passed in, read and written through.
interface Named {
  name: string;
}

function keep<T>(t: T): T {
  return t;
}

function first<T>(a: T, b: T): T {
  return a ?? b;
}

function rename(v: Named, to: string) {
  const kept = keep(v);
  kept.name = to;
  console.log(kept.name, v.name, kept === v);
  const either = first(v, { name: 'other' });
  console.log(either.name, either === v);
}

const loose: any = { name: 'a' };
rename(loose, 'b');
console.log(loose.name);
const typed: Named = { name: 'c' };
rename(typed, 'd');
console.log(typed.name);
