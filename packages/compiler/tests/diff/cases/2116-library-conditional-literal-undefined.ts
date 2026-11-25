// @lenient-both
// Library code: a conditional of two object literals TypeScript reduces to one shape keeps the field a branch gives
// undefined as undefined: JSON leaves it out, its key is still there, and it compares equal to undefined.
const step = (k: number) => (k > 0 ? { value: k, done: false } : { value: undefined, done: true });
const end = step(0);
console.log(JSON.stringify(end), Object.keys(end).join(), end.value === undefined, typeof end.value, String(end.value));
console.log(JSON.stringify(step(2)), step(2).value === undefined);
