// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): rest parameters, tagged templates, arguments, arrows, `this` and call/apply.
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, e instanceof TypeError ? 'TypeError' : e instanceof ReferenceError ? 'ReferenceError' : 'other');
  }
}

function f(...args: any[]) {
  return args;
}
console.log('f(1, 2, 3)', f(1, 2, 3)); // wtfjs: Calling functions with backticks
const ten: any = () => 10;
const nothing: any = () => {};
const emptyObj: any = () => ({});
console.log('(() => 10)()', ten()); // wtfjs: Tricky arrow functions
console.log('(() => {})()', nothing()); // wtfjs: Tricky arrow functions
console.log('(() => ({}))()', emptyObj()); // wtfjs: Tricky arrow functions
const arrow: any = () => 1;
attempt('new arrow', () => new arrow()); // wtfjs: Arrow functions can not be a constructor
function alias(x?: any) {
  arguments[0] = 'hello';
  return x;
}
console.log('arguments[0] = "hello"', alias(), alias(1)); // wtfjs: `arguments` binding
const obj: any = {
  n: 1,
  regular() { return this?.n; },
  arrowed: () => typeof this,
};
const detached = obj.regular;
console.log('this', obj.regular(), detached(), obj.arrowed(), detached.call({ n: 2 }), detached.bind({ n: 3 })());

// Statically typed.
function g(...xs: number[]): number[] {
  return xs;
}
function strings(parts: TemplateStringsArray, ...keys: unknown[]) {
  return [parts.length, parts.raw[0], ...keys];
}
console.log('typed f(1, 2, 3)', g(1, 2, 3), g().length); // wtfjs: Calling functions with backticks
console.log('typed tag', strings`true is ${true}, false is ${false}, array is ${[1, 2, 3]}`); // wtfjs: Calling functions with backticks
const zero = (): void => {};
const object = () => ({});
console.log('typed arrows', zero(), object()); // wtfjs: Tricky arrow functions
