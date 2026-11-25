// @kotlin ledger:failedUnwrapThrows
// Object-typed locals tested for presence, whose checker narrowing outlives the value: a closure clears it, a write in
// between or in a loop stores an undefined the types deny. Each use still throws JavaScript's TypeError. (Swift traps
// there, the class of 247.)
class Node1 {
  next: Node1 | undefined = undefined;
  constructor(public name: string, public v: number) {}
  describe(): string {
    return `${this.name}:${this.v}`;
  }
}

function make(name: string, v: number): Node1 | undefined {
  return v >= 0 ? new Node1(name, v) : undefined;
}

function gone(): Node1 {
  return undefined as unknown as Node1;
}

function cleared(): string {
  let x = make('gone', 0);
  const clear = () => {
    x = undefined;
  };
  if (!x) return 'none';
  clear();
  try {
    return x.describe();
  } catch (e) {
    return (e as TypeError).message;
  }
}
console.log(cleared());

function between(): string {
  let x = make('first', 1);
  if (!x) return 'none';
  const before = x.v;
  x = gone();
  try {
    return `${before} ${x.v}`;
  } catch (e) {
    return `${before} ${(e as TypeError).message}`;
  }
}
console.log(between());

function walk(): string {
  const a = new Node1('a', 1);
  a.next = new Node1('b', 2);
  let x = make('a', 1);
  if (x) x.next = a.next;
  if (!x) return 'none';
  const seen: string[] = [];
  try {
    for (let k = 0; k < 3; k++) {
      seen.push(x.name);
      x = k === 1 ? gone() : (x.next as Node1);
    }
  } catch (e) {
    seen.push((e as TypeError).message);
  }
  return seen.join(' ');
}
console.log(walk());

