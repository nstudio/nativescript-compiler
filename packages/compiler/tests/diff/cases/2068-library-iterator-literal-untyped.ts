// @lenient-both
// Library mode: an iterator object literal returned from a method without a declared result type.
class Counter {
  limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  [Symbol.iterator]() {
    let i = 0;
    const limit = this.limit;
    return {
      next: () => {
        const done = i >= limit;
        const value = done ? limit : i++;
        return { value, done };
      },
    };
  }
  cursor() {
    let i = 10;
    return {
      next: () => {
        i++;
        return { value: i, done: i > 12 };
      },
    };
  }
}
const c = new Counter(3);
const seen = [];
for (const x of c) seen.push(x);
console.log(seen.join(','), [...new Counter(2)].join(','));
const cur = c.cursor();
let r = cur.next();
while (!r.done) {
  console.log(r.value, r.done);
  r = cur.next();
}
console.log(r.value, r.done);
