// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): labels, finally, chained assignment, destructuring defaults, ASI and redeclaration.
const seen: string[] = [];
foo: {
  seen.push('first');
  if (seen.length) break foo;
  seen.push('second');
}
console.log('labelled block break', seen); // wtfjs: Labels
let x: any;
const { x: y = 1 }: any = { x };
console.log('let x, { x: y = 1 } = { x }', y); // wtfjs: Destructuring with default values
var foo: any = { n: 1 };
var bar: any = foo;
foo.x = foo = { n: 2 };
console.log('foo.x = foo = { n: 2 }', foo.x, foo, bar); // wtfjs: Chaining assignments on object
const asi: any = function () {
  return;
};
console.log('return then newline', asi()); // wtfjs: Tricky return
const braced: any = function () {
  return {
    b: 10,
  };
};
console.log('return {', braced()); // wtfjs: Tricky return
var a: any;
var a: any;
console.log('var a, a', a); // wtfjs: Same variable redeclaration
let order = '';
const note = (s: string) => ((order += s), s);
const target: any = {};
target[note('k')] = note('v');
console.log('evaluation order', order, target);
outer: for (const i of [1, 2, 3]) {
  for (const j of [1, 2, 3]) {
    if (j === 2) continue outer;
    if (i === 3) break outer;
    seen.push(`${i}${j}`);
  }
}
console.log('labelled loops', seen);
let completion = 0;
a: b: c: d: e: f: g: completion = (seen.pop(), 5);
console.log('nested labels', completion, seen.length); // wtfjs: Nested labels
const fall = (n: number) => {
  const out: string[] = [];
  switch (n) {
    case 1: out.push('one');
    case 2: out.push('two'); break;
    default: out.push('other');
  }
  return out;
};
console.log('switch fallthrough', fall(1), fall(2), fall(3));

// Statically typed.
function finallyTyped(): number {
  try {
    return 2;
  } finally {
    console.log('typed finally runs');
  }
}
console.log('typed try/finally', finallyTyped()); // wtfjs: Insidious `try..catch`
let tx: number | undefined;
const { tx: ty = 1 } = { tx };
console.log('typed destructuring default', ty); // wtfjs: Destructuring with default values
type Node2 = { n: number; x?: Node2 };
let first: Node2 = { n: 1 };
const keep: Node2 = first;
first.x = first = { n: 2 };
console.log('typed chained assignment', first.x, first, keep); // wtfjs: Chaining assignments on object
