// A callback declaring fewer parameters than an array's or typed array's method gives it, none too: called with each element.
let called = 0;
const xs = [1, 2];
console.log(xs.every(function () { called++; return true; }), called);
const ta = new Float32Array([1, 2, 3]);
console.log(ta.every(function () { called++; return true; }), called);
ta.forEach(function () { called++; });
console.log(ta.some(() => false), ta.map(() => 7).join(), ta.filter(() => true).length, ta.find(() => true), ta.findIndex(() => false), called);
console.log(xs.findLastIndex(function () { called++; return true; }), called);
