// DataView.prototype, which neither runtime holds an object for: its accessors read off it reflectively.
// @refused DataView.prototype is not supported in a release build yet
const byteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength');
console.log(typeof byteLength?.get);
