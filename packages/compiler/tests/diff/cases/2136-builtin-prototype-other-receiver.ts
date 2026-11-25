// A String.prototype method called through .call on a value that is not a string: JavaScript converts the value to a
// string first (its own toString here), where a compiled build would look the method up on the value itself.
// @refused call of String.prototype.trim on a value that is not a string is not supported in a release build yet
const label = { toString: () => '  padded  ' };
console.log(`[${String.prototype.trim.call(label)}]`);
console.log(String.prototype.trim.call(false));
