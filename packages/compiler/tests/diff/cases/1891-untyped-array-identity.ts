// An array returned through an untyped call result (Array.prototype.X.call) is the receiver itself, whatever the slot's element type.
const a = [1, 2, 3, 4, 5];
const r = Array.prototype.copyWithin.call(a, 0, 3);
console.log('copyWithin', r === a, a.join(','));
const filled = Array.prototype.fill.call(a, 0, 4);
console.log('fill', filled === a);
const words: any[] = ['x', 'y'];
const viaAny: any = words;
const again: any[] = viaAny;
console.log('any[]', again === words);
const rev = Array.prototype.reverse.call(words);
console.log('reverse', rev === words, words.join(','));
const strs = ['p', 'q'];
const rev2 = Array.prototype.reverse.call(strs);
console.log('reverse2', rev2 === strs, strs.join(','));
