// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): `call` called through `call` and `apply`, with another receiver.
function log(...args: unknown[]) {
  console.log(...args);
}
const call: any = log;
console.log('log.call.call.call.call.call.apply', call.call.call.call.call.call.apply((a: any) => a, [1, 2])); // wtfjs: Call call call
