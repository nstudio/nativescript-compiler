// Object types that contain themselves (a tree of leaf and branch objects, a linked list): its sizes are the objects script makes, read, written and compared as they are.
type Tree = { size: number } | { left: Tree; right: Tree };
type ListNode = { label: string; next?: ListNode };

function total(t: Tree): number {
  return 'size' in t ? t.size : total(t.left) + total(t.right);
}

const leaf = { size: 3 };
const branch: { left: Tree; right: Tree } = { left: leaf, right: { size: 4 } };
const tree: Tree = { left: { size: 1 }, right: branch };
console.log(total(tree), JSON.stringify(tree));
leaf.size = 30;
branch.right = { left: { size: 5 }, right: leaf };
if ('left' in tree) console.log(total(tree), tree.right === branch, 'left' in tree.right, JSON.stringify(tree));

const head: ListNode = { label: 'a', next: { label: 'b', next: { label: 'c' } } };
const labels: string[] = [];
for (let n: ListNode | undefined = head; n; n = n.next) labels.push(n.label);
head.next!.next!.next = { label: 'd' };
const tail = head.next!.next!.next!;
console.log(labels.join(''), JSON.stringify(head), tail.label, tail.next === undefined, head.next!.next!.next === tail);
