// A class's method read off its prototype object and called there, as JavaScript holds the class's methods.
// @refused a class member read off Counter.prototype is not supported in a release build yet
class Counter {
  step(by = 1) {
    return by * 2;
  }
}
console.log(Counter.prototype.step(3));
console.log(typeof Counter.prototype.step);
