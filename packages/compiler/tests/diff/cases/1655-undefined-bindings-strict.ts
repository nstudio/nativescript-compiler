// Strict app code's strings, numbers and booleans holding the undefined of a read past an array's end: bound, assigned,
// compared, switched on and passed on as undefined, converted only where JavaScript converts (a template, `+`,
// `String`), and a member read or method call of one is JavaScript's TypeError.
function attempt(label: string, f: () => unknown) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}
function kinds(s: string, n: number, b: boolean): string {
  return `${typeof s}/${typeof n}/${typeof b}`;
}
function pick(code: string): string {
  switch (code) {
    case 'undefined':
      return 'text';
    case 'a':
      return 'first';
    default:
      return 'none';
  }
}
function parts(line: string) {
  const [head, tail] = line.split('=');
  const ones: number[] = [1];
  const yes: boolean[] = [true];
  const [n0, n1] = ones;
  const [f0, f1] = yes;
  console.log(kinds(tail, n1, f1), tail === 'undefined', tail === undefined, pick(tail), `${tail}|${n1}|${f1}`, head + tail, String(n1 + 1));
  attempt('upper', () => tail.toUpperCase());
  attempt('fixed', () => n1.toFixed(1));
  console.log(n0 === n1, f0 === f1, f1 === false, !f1);
  return tail;
}
console.log(parts('k=v'), parts('k'));

const names = ['ann', 'bo'];
let chosen = 'none';
for (let k = 0; k <= names.length; k++) chosen = names[k];
console.log(chosen === undefined, typeof chosen, pick(chosen), kinds(chosen, 0, true));
attempt('chosen', () => chosen.length);

