// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a promise resolved with a promise, a generator yielding itself, setTimeout with Infinity.
const theObject: any = { a: 7 };
const p1: any = new Promise((resolve) => resolve(theObject));
p1.then((value: any) => {
  console.log('resolved object is itself', value === theObject); // wtfjs: resolve() won't return Promise instance
  console.log('resolved object', value); // wtfjs: resolve() won't return Promise instance
});
const inner: any = new Promise((resolve) => resolve(7));
const p2: any = new Promise((resolve) => resolve(inner));
p2.then((value: any) => {
  console.log('resolved promise is adopted', value === inner); // wtfjs: resolve() won't return Promise instance
  console.log('adopted value', value); // wtfjs: resolve() won't return Promise instance
});
setTimeout(() => console.log('setTimeout Infinity called'), Infinity); // wtfjs: An infinite timeout
setTimeout(() => console.log('setTimeout NaN called'), NaN);
console.log('sync first');

// Statically typed.
const box = { a: 7 };
new Promise<typeof box>((resolve) => resolve(box)).then((v) => console.log('typed resolved object', v === box, v)); // wtfjs: resolve() won't return Promise instance
const innerTyped = Promise.resolve(7);
new Promise<number>((resolve) => resolve(innerTyped)).then((v) => console.log('typed adopted', v)); // wtfjs: resolve() won't return Promise instance
function* self(): Generator<unknown> {
  yield self;
}
const s = self().next();
console.log('typed generator', s.done, s.value === self); // wtfjs: A generator which yields itself
Promise.resolve().then(() => console.log('microtask before timers'));
