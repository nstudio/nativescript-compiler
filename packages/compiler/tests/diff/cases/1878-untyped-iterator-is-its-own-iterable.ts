// An iterator's [Symbol.iterator]() is the iterator itself, whether it is held typed or untyped.
const it: any = [1, 2, 3][Symbol.iterator]();
const self = it[Symbol.iterator]();
console.log(self === it);
it.next();
console.log(JSON.stringify(self.next()), JSON.stringify(it.next()));
function* gen() { yield 'a'; yield 'b'; }
const g: any = gen();
console.log(g[Symbol.iterator]() === g);
