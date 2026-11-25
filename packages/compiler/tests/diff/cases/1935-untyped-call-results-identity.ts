// Array.prototype methods called through `.call` on a typed array give the receiver itself where JavaScript does.
const a = [5, 1, 4];
const sorted = Array.prototype.sort.call(a);
console.log('sort', sorted === a, a.join(','));
const rev = Array.prototype.reverse.call(a);
console.log('reverse', rev === a, a.join(','));
const filled = Array.prototype.fill.call(a, 0, 2);
console.log('fill', filled === a, a.join(','));
const copied = Array.prototype.copyWithin.call(a, 0, 1);
console.log('copyWithin', copied === a, a.join(','));
const sliced = Array.prototype.slice.call(a);
console.log('slice', sliced === a, sliced.length);
const names = ['b', 'a'];
const s2: any[] = Array.prototype.sort.call(names);
s2.push('c');
console.log(s2 === names, names.join(','));
