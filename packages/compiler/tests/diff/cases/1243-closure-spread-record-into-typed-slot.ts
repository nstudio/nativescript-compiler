// A callback building a record by spread and computed key where its slot's result is a typed record.
interface Meta { unread: number; open: boolean }

class Store {
  meta: Record<string, Meta> = { t0: { unread: 1, open: true } };
  update(fn: (value: Record<string, Meta>) => Record<string, Meta>): void { this.meta = fn(this.meta); }
}

const s = new Store();
const id = 't1';
s.update((m) => {
  const current = m[id] ?? { unread: 0, open: false };
  return { ...m, [id]: { ...current, unread: 3 } };
});
console.log(JSON.stringify(s.meta));
