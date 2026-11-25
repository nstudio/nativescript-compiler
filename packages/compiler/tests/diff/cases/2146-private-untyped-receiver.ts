// A private field read on a receiver typed any: JavaScript throws TypeError where the object is not one of the class's.
// @refused `#value` of a value not typed as its class is not supported in a release build yet
class Box {
  #value = 1;
  static read(o: any) {
    return o.#value;
  }
}
console.log(Box.read(new Box()));
try {
  Box.read({});
} catch (e) {
  console.log(e instanceof TypeError);
}
