// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a function expression that sets `this`, called with `new`.
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, e instanceof TypeError ? 'TypeError' : e instanceof ReferenceError ? 'ReferenceError' : 'other');
  }
}
const ctor: any = function (this: any) {
  this.a = 1;
};
attempt('new function', () => new ctor()); // wtfjs: Arrow functions can not be a constructor
