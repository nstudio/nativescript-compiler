// A destructured parameter whose function is given nothing for it: V8's TypeError, caught, for undefined and null,
// for an object and an array pattern, through a callback, a method and a function. Null's message is not compared:
// a typed parameter holds null and undefined as one empty value.
interface Box {
  top: number;
  left: number;
}

type Place = (name: string, box: Box) => string;

class Layout {
  resize(w: number, { top, left }: Box): string {
    return `${w}:${top},${left}`;
  }
}

function pair([a, b]: number[]): number {
  return a + b;
}

const place: Place = (name, { top }) => `${name}@${top}`;
const layout = new Layout();
const nothing: any = undefined;
const empty: any = null;

const tries: [string, () => unknown][] = [
  ['place', () => place('a', { top: 1, left: 2 })],
  ['place undefined', () => place('a', nothing)],
  ['place null', () => place('a', empty)],
  ['resize', () => layout.resize(3, { top: 4, left: 5 })],
  ['resize undefined', () => layout.resize(3, nothing)],
  ['resize null', () => layout.resize(3, empty)],
  ['pair', () => pair([1, 2])],
  ['pair undefined', () => pair(nothing)],
  ['pair null', () => pair(empty)],
];
for (const [label, run] of tries) {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, e instanceof TypeError, label.endsWith('null') ? '' : (e as Error).message);
  }
}
