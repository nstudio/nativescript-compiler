// `for…of` over a value held untyped calls `next()` once per iteration, interleaved with the body's effects, and
// closes the iterator when the loop leaves early, in an async function whose loop body awaits as well.
const log: string[] = [];
function counter(limit: number) {
  let i = 0;
  return {
    [Symbol.iterator]() {
      return {
        next() { log.push(`next${i}`); return i < limit ? { value: i++, done: false } : { value: undefined, done: true }; },
        return() { log.push('return'); return { value: undefined, done: true }; },
      };
    },
  };
}
const three: any = counter(3);
for (const x of three) log.push(`body${x}`);
console.log(log.join(' '));
log.length = 0;
const five: any = counter(5);
for (const x of five) { log.push(`body${x}`); if (x === 1) break; }
console.log(log.join(' '));
log.length = 0;

function* gen(): Generator<number> {
  for (let i = 0; i < 3; i++) { log.push(`yield${i}`); yield i; }
}
const held: any = gen();
for (const x of held) log.push(`got${x}`);
console.log(log.join(' '));

let calls = 0;
const throwing = {
  [Symbol.iterator]() {
    return { next() { calls++; if (calls === 2) throw new Error('second next'); return { value: calls, done: false }; } };
  },
};
const lazy: any = throwing;
const got: number[] = [];
try {
  for (const v of lazy) got.push(v);
} catch (e) {
  console.log((e as Error).message, got.join(','), calls);
}

async function drain(source: any): Promise<void> {
  for (const x of source) {
    await null;
    log.push(`async${x}`);
    if (x === 1) break;
  }
}
log.length = 0;
drain(counter(4)).then(() => console.log(log.join(' ')));

// An array held untyped and grown while `for…of` iterates it: the loop reads its live length, so it sees what the
// body pushes and stops early where the body shrinks it.
const items: any = [1, 2, 3];
const seen: number[] = [];
for (const x of items) {
  seen.push(x);
  if (x < 3) items.push(x + 10);
}
console.log(seen.join(','), items.length);

const letters: string[] = ['a', 'b', 'c', 'd'];
const shrink: any = letters;
const kept: string[] = [];
for (const s of shrink) {
  kept.push(s);
  letters.pop();
}
console.log(kept.join(','), letters.length);

const numbers: number[] = [1, 2];
const list: unknown = numbers;
const out: string[] = [];
for (const v of list as any) {
  out.push(String(v));
  if (v === 1) numbers.push(3);
}
console.log(out.join(' '));
