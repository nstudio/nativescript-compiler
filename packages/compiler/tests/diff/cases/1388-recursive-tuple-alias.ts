// A tuple alias that contains itself: built, walked, written and stringified as the arrays JavaScript makes.
type Markup = [tagName: string, attrs?: object, ...children: Markup[]];
type Link = [value: number, next: Link | null];

function render(node: Markup, depth: number): string {
  const [tag, attrs, ...children] = node;
  const own = '  '.repeat(depth) + tag + (attrs ? ' ' + JSON.stringify(attrs) : '');
  return [own, ...children.map((c) => render(c, depth + 1))].join('\n');
}

const leaf: Markup = ['span', { id: 1 }];
const tree: Markup = ['div', { class: 'a' }, ['p', {}, leaf], ['ul', undefined, ['li'], ['li', { n: 2 }]]];
console.log(render(tree, 0));
console.log(JSON.stringify(tree));
console.log(Array.isArray(tree), Array.isArray(tree[2]), tree.length, (tree[2] as Markup)[2] === leaf);
(tree[3] as Markup).push(['li', { n: 3 }]);
leaf[0] = 'b';
console.log(JSON.stringify(tree));

const list: Link = [1, [2, [3, null]]];
let sum = 0;
for (let at: Link | null = list; at; at = at[1]) sum += at[0];
const second = list[1]!;
second[0] = 20;
console.log(sum, JSON.stringify(list), list[1] === second, Array.isArray(second));
