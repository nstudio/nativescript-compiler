// Object-typed locals tested for presence (`!x`, `x &&`, `x ?`, `x?.child`), then used as present: in later statements
// after an early return/continue, in the tested branch, in an else, in nested blocks, through an intersection type and
// a parameter (1704: where the checker's narrowing outlives the value).
class Node1 {
  next: Node1 | null = null;
  child: Node1 | null = null;
  constructor(public name: string, public v: number) {}
  describe(): string {
    return `${this.name}:${this.v}`;
  }
}

function early(bar: Node1 | null, limit: number): string {
  if (!bar || bar.v > limit) {
    return 'skipped';
  }
  const extra = bar.describe();
  return `${extra} ${bar.v + 1}`;
}
console.log(early(null, 5), early(new Node1('a', 9), 5), early(new Node1('b', 2), 5));

function inLoop(lines: string[]): string {
  const out: string[] = [];
  let cur: (Partial<Node1> & { tags: string[] }) | null = null;
  for (const line of lines) {
    if (line === 'B') {
      cur = { tags: [] };
      continue;
    }
    if (line === 'E') {
      if (cur?.name) out.push(`${cur.name}[${cur.tags.join('|')}]`);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const [key, value] = line.split('=');
    switch (key) {
      case 'name':
        cur.name = value;
        break;
      case 'tag':
        for (const t of value.split(',')) cur.tags.push(t);
        break;
      default:
        if (value) {
          cur.tags.push(`${key}?`);
        }
    }
  }
  return out.join(' ');
}
console.log(inLoop(['name=x', 'B', 'name=first', 'tag=a,b', 'odd=1', 'E', 'tag=z', 'B', 'tag=q', 'E', 'B', 'name=third', 'E']));

function branches(x: Node1 | null): string {
  const a = x && x.v;
  const b = x ? x.describe() : 'none';
  let c = 'no child';
  if (x?.child) c = x.child.describe() + ' of ' + x.name;
  let d: string;
  if (!x) {
    d = 'absent';
  } else {
    d = x.name.toUpperCase();
  }
  return `${a} ${b} ${c} ${d}`;
}
const parent = new Node1('p', 1);
parent.child = new Node1('c', 2);
console.log(branches(null), '/', branches(parent), '/', branches(new Node1('q', 0)));

function param(p: Node1 | undefined): string {
  if (p === undefined) return 'undefined';
  return p.describe();
}
console.log(param(undefined), param(new Node1('r', 3)));

function captured(xs: number[]): string {
  const x: Node1 | null = xs.length ? new Node1('cap', xs.length) : null;
  if (!x) return 'none';
  return xs.map((n) => n + x.v).join(',');
}
console.log(captured([]), captured([1, 2]));
