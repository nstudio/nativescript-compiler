// A function expression outside any class stored on a typed object, reading `this`: JavaScript gives it the receiver of
// each call.
// @refused `this` in a function expression stored on an object is not supported in a release build yet
interface Counter {
  count: number;
  bump: () => number;
}
const counter: Counter = { count: 0, bump: () => 0 };
counter.bump = function () {
  return ++this.count;
};
console.log(counter.bump(), counter.bump(), counter.count);
