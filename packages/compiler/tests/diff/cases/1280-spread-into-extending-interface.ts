// An object literal spreading one interface's value where an interface extending it is wanted: the spread's fields
// are the new object's, alongside its own. A literal giving every field is one too.
interface Item { id: string; title: string; note?: string; tags?: string[]; createdAt: string }
interface ShownItem extends Item { label: string; count: number; extra?: string | null }

function show(item: Item, n: number): ShownItem {
  return {
    ...item,
    label: `${item.title}!`,
    count: n,
    extra: n > 1 ? 'many' : null,
  };
}

const a: Item = { id: 'a', title: 'first', createdAt: '2026' };
const b: Item = { id: 'b', title: 'second', note: 'n', tags: ['x'], createdAt: '2027' };
const sa = show(a, 1);
const sb = show(b, 2);
console.log(JSON.stringify(sa));
console.log(JSON.stringify(sb));
console.log(sa.id, sa.title, sb.note, sb.tags?.length, sa.note === undefined, sa.label, sb.count);
sa.title = 'changed';
console.log(a.title, sa.title);
const list: ShownItem[] = [a, b].map((x, i) => ({ ...x, label: x.id, count: i }));
console.log(JSON.stringify(list));
const whole: ShownItem = { id: 'w', title: 'whole', createdAt: '2028', label: 'L', count: 0 };
console.log(JSON.stringify(whole), whole.id, whole.label);
