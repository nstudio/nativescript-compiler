// A switch with no clauses, or only an empty default, still evaluates its subject once and goes on to the statements
// after it: in a function returning a value after it, ending a function, in a loop, in an async function.
let calls = 0;
function next(tag: string): string {
  calls++;
  console.log('subject', tag, calls);
  return tag;
}
function afterEmpty(s: string): number {
  switch (next(s)) {
  }
  console.log('after empty', s);
  return s.length;
}
function afterEmptyDefault(s: string): string {
  switch (next(s)) {
    default:
  }
  return 'default ' + s;
}
function afterDefault(s: string): number {
  switch (next(s)) {
    default:
      console.log('in default', s);
  }
  return calls;
}
function endsEmpty(s: string): void {
  console.log('before', s);
  switch (next(s)) {
  }
}
const endsUnknown: (s: string) => unknown = (s) => {
  switch (next(s)) {
  }
};
const endsAny = (n: number): any => {
  switch (n) {
    default:
  }
};
function maybe(n: number): number | undefined {
  switch (n * 2) {
  }
  if (n > 1) return n;
}
console.log(afterEmpty('ab'), afterEmptyDefault('c'), afterDefault('d'));
console.log(endsEmpty('e'), endsUnknown('f'), endsAny(3), maybe(1), maybe(2));
const seen: number[] = [];
for (let i = 0; i < 3; i++) {
  switch (i) {
  }
  if (i === 1) continue;
  seen.push(i);
}
console.log(seen.join(','), calls);
function other<T>(v: T): T {
  calls++;
  return v;
}
switch (other(true)) {
}
switch (other({ k: 1 })) {
  default:
}
switch (other<unknown>(JSON.parse('null'))) {
}
console.log('subjects', calls);
async function later(s: string): Promise<string> {
  const v = await Promise.resolve(s);
  switch (next(v)) {
  }
  const w = await Promise.resolve(v + '!');
  switch (w) {
    default:
  }
  switch (await Promise.resolve(next(w))) {
  }
  return w;
}
later('g').then((r) => console.log('async', r, calls));
