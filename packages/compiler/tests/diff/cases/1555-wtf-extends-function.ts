// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a class extending Function, its instances constructed with `new`.
// @refused extending Function is not supported in a release build yet
class Foo extends Function { // wtfjs: Extra Newness
  constructor(val: string) {
    super();
    this.prototype.val = val;
  }
}
const made: any = new Foo(':D'); // wtfjs: Extra Newness
console.log('new new Foo(":D")().val', new made().val); // wtfjs: Extra Newness
console.log('typeof new Foo', typeof made, made instanceof Function);
