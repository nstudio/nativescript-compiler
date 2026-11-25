// Function.prototype.call called through call, typed: the receiver it is given is another function.
// @refused-swift call with a receiver other than the method's object is not supported
console.log('Function.prototype.call.call', Function.prototype.call.call((a: unknown) => a, undefined, 7)); // wtfjs: Call call call
