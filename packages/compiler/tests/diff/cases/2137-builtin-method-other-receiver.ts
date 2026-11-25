// A built-in's method read off one value and called through .call on another: JavaScript runs it on the receiver given,
// where a compiled build holds the method bound to the value it was read from.
// @refused call of ''.padStart with a receiver other than the value it is read from is not supported in a release build yet
const code = '42';
console.log(''.padStart.call(code, 5, '0'));
