// Conditions on strings, booleans and class instances as they are held: present, optional, a getter read each test.
class Node {
  constructor(public name: string, public next?: Node) {}
}
class Holder {
  reads = 0;
  label = '';
  flag = false;
  head: Node | undefined;
  maybe: Node | null = null;
  get node(): Node {
    this.reads++;
    return new Node('got');
  }
}
const out: string[] = [];
const h = new Holder();
const test = (tag: string) => {
  out.push(`${tag}:${h.label ? 'L' : '-'}${!h.label ? '!' : ''}${h.flag ? 'F' : '-'}${h.head ? 'H' : '-'}${!h.head ? '!' : ''}${h.maybe ? 'M' : '-'}`);
};
test('a');
h.label = 'x'; h.flag = true; h.head = new Node('one', new Node('two')); h.maybe = h.head;
test('b');
let cur: Node | undefined = h.head;
while (cur) { out.push(cur.name); cur = cur.next; }
const solid = new Node('solid');
if (solid) out.push('solid');
if (h.node) out.push(`node${h.reads}`);
if (!h.node) out.push('never');
out.push(`reads${h.reads}`);
const words = ['', 'a', '0'];
for (const w of words) if (w) out.push(`w${w}`); else out.push('empty');
console.log(out.join(' '));
