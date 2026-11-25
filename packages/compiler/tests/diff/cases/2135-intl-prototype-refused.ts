// @refused Intl.NumberFormat.prototype is not supported in a release build yet
// An Intl constructor's prototype object.
const nf = new Intl.NumberFormat('en-US');
console.log(Object.getPrototypeOf(nf) === Intl.NumberFormat.prototype);
