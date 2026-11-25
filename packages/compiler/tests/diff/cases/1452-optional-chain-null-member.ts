// An optional chain is undefined only when its base is null or undefined; otherwise it is the member's value, null included.
interface Item {
  label: string;
  note?: string | null;
}
class Box {
  note?: string | null;
  inner: Box | null = null;
}
function noteOf(item: Item | null): string | null | undefined {
  return item?.note;
}
function boxNoteOf(box: Box | undefined): string | null | undefined {
  return box?.note;
}
const show = (v: string | null | undefined) => (v === null ? 'null' : v === undefined ? 'undefined' : v);
const items: (Item | null)[] = [null, { label: 'a' }, { label: 'b', note: null }, { label: 'c', note: 'n' }];
for (const item of items) {
  const held: string | null | undefined = item?.note;
  console.log(show(noteOf(item)), show(item?.note), show(held), item?.note, String(item?.note), `${item?.note}`, item?.note === null, item?.note === undefined);
}
const box = new Box();
console.log(show(boxNoteOf(undefined)), show(boxNoteOf(box)), box?.note);
box.note = null;
console.log(show(boxNoteOf(box)), box?.note, String(box?.note), show(box.note));
box.inner = new Box();
box.inner.note = null;
console.log(show(box?.inner?.note), box.inner?.note, box?.inner?.note === null);
const outer: { box: Box } | null = { box };
console.log(show(outer?.box.inner?.note), outer?.box.note, outer?.box.inner?.note === null);
box.note = 'set';
console.log(show(boxNoteOf(box)), box?.note);
