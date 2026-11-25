// @exit 1
// A match that needs more backtracking than the engine's stack holds is V8's RangeError, uncaught here; one well
// within it matches as usual.
const within = 'ab'.repeat(100000) + 'x';
console.log(/^(?:a|b)*c/.test(within), /^(?:a|b)*x$/.test(within));
console.log('deep');
/^(?:a|b)*c/.test('a'.repeat(10000000) + 'x');
console.log('not reached');
