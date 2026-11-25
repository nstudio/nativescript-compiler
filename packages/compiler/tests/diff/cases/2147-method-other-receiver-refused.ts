// A class method called through .call with another object as receiver: both backends hold a method bound to its object.
// @refused call with a receiver other than the method's object is not supported in a release build yet
class Box {
  constructor(public value: number) {}
  read() {
    return this.value;
  }
}
const a = new Box(1);
const b = new Box(2);
console.log(a.read.call(b));
