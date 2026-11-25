// @lenient-both
// Library mode: a variable of one of the program's classes that a function giving null sets, compared with null and
// undefined, which the null it holds tells apart.
class Node {
  constructor(public name: string) {}
}
function find(name: string): Node {
  if (name === 'none') return null;
  return new Node(name);
}
function compare(name: string): string {
  let reassigned = new Node('first');
  reassigned = find(name);
  const typed: Node = find(name);
  let later: Node;
  later = find(name);
  const plain = find(name);
  return [reassigned === null, reassigned !== null, reassigned === undefined, typed === null, typed !== undefined, later === null, later == null, plain === null, plain === undefined].join();
}
function unset(): string {
  let never: Node;
  const made = new Node('m');
  return [never === undefined, made === null, made === undefined].join();
}
console.log(compare('none'));
console.log(compare('a'));
console.log(unset());
let top = find('none');
console.log(top === null, top === undefined, top == null);
top = find('b');
console.log(top === null, top === undefined, top.name);
