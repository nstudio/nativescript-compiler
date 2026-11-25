// @lenient-both
// Library mode (core's build, fields assigned): a field declared without a value is an own key from its first write, and
// keys list in the order they were made, which Object.keys, for…in, JSON.stringify, spread and Object.entries all follow.
class Item {
  label: string;
  count: number;
  tags: string[];
  name = 'n';
}
const a = new Item();
a.tags = ['t'];
a.count = 2;
console.log(Object.keys(a).join(), JSON.stringify(a));
a.label = 'x';
a.count = 3;
const seen: string[] = [];
for (const k in a) seen.push(k);
console.log(seen.join(), JSON.stringify({ ...a }), Object.entries(a).map(([k, v]) => `${k}=${v}`).join(' '));
const b = new Item();
b.label = 'y';
console.log(Object.keys(b).join(), 'count' in b, b.hasOwnProperty('tags'), Object.keys(a).join());
