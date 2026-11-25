// Built-in methods called by name on arrays and strings held untyped: each as Array.prototype's or String.prototype's.
const nums: any = [5, 1, 4, 10];
console.log(nums.sort(), nums.reverse(), nums.at(-1), nums.at(9));
console.log(nums.reduce((a: any, b: any) => a + b), nums.reduceRight((a: any, b: any) => a + b, ''));
const xs: any = ['a', 'b', 'c', 'd'];
console.log(xs.splice(1, 2, 'x'), xs, xs.findLast((s: any) => s < 'd'), xs.findLastIndex((s: any) => s === 'q'));
console.log(xs.flatMap((s: any) => [s, s.toUpperCase()]), xs.flat(), [...xs.keys()], [...xs.entries()].length);
console.log(xs.unshift('z'), xs.shift(), xs.pop(), xs.fill('f', 1), xs.toString());
const s: any = 'héllo wörld';
console.log(s.at(-1), s.at(99), s.codePointAt(1), s.codePointAt(99), s.concat('!', 1, null), s.localeCompare('a'), s.localeCompare(s));
console.log([...s.matchAll(/o/g)].map((m: any) => m.index), s.toLocaleUpperCase(), 'ABC'.toLocaleLowerCase());
const mixed: any = [10, 'b', 2, undefined, 'a', null, 1];
console.log(mixed.sort(), mixed.length);
