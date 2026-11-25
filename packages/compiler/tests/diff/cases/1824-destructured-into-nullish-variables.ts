// A destructuring assignment writes a variable that keeps null apart from undefined (`T | null | undefined`): what the
// member holds, null kept, a default replacing undefined only, an element past the array's end undefined.
let x: string | null | undefined = 'a';
let y: number | null | undefined;
const o: { x?: string | null; y?: number | null } = { x: null, y: 2 };
({ x, y } = o);
console.log(x, y, x === null, y === undefined);
let a: string | null | undefined = 'z';
let b: string | null | undefined = null;
[a, b] = ['only'] as string[];
console.log(a, b, b === undefined);
({ x = 'dflt' } = {} as { x?: string | null });
console.log(x);
({ x = 'dflt' } = { x: null } as { x?: string | null });
console.log(x, x === null);
({ y: x } = { y: 'renamed' });
console.log(x);
function f(p: { k?: string | null }) {
  let k: string | null | undefined = 'start';
  ({ k } = p);
  return k === null ? 'null' : k === undefined ? 'undefined' : k;
}
console.log(f({}), f({ k: null }), f({ k: 'v' }));
