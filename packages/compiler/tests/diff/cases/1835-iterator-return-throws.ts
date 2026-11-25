// A `for…of` left by `break` closes its iterator, and what `return()` throws reaches the program; left by a throw, the throw wins.
function make(log: string[]) {
  return {
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() { return { value: i++, done: i > 3 }; },
        return(): IteratorResult<number> { log.push('return'); throw new Error('from return'); },
      };
    },
  };
}
const log: string[] = [];
try {
  for (const x of make(log)) { if (x === 1) break; }
  console.log('no error');
} catch (e) {
  console.log('break:', (e as Error).message);
}
try {
  for (const x of make(log)) { if (x === 1) throw new Error('from body'); }
} catch (e) {
  console.log('throw:', (e as Error).message);
}
console.log(log.join(','));
