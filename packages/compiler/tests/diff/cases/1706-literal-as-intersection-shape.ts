// An object literal made as the shape class of the wider intersection type it is placed as (`Partial<Ev> & {…} | null`):
// the object it was made as, never a view of it; asserted to the interface and pushed, its keys in literal order.
// (Swift traps under fuzz here: the instrumented argument of `cur.tags.add` alone, and `cur as Ev` given a wrong value.)
interface Ev {
  uid: string;
  summary: string;
  start?: { y: number };
  tags: Set<string>;
}
const events: Ev[] = [];
let cur: (Partial<Ev> & { tags: Set<string> }) | null = null;
cur = { tags: new Set(), summary: '', uid: 'u1' };
const held = cur;
cur.start = { y: 2026 };
cur.tags.add('x');
events.push(cur as Ev);
console.log(events[0] === (held as Ev), Object.keys(cur).join(','));
console.log(JSON.stringify(events.map((e) => [e.uid, e.summary, e.start, [...e.tags]])));
