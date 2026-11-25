// The rewrites the refusal catalog suggests for deletes, indexing and generic erasure (src/semantics/refusals.ts), each as written there.
// delete-member: a Map for entries that come and go.
class Store {
  cache = new Map<string, number>();
  drop(key: string) { this.cache.delete(key); }
}
const st = new Store();
st.cache.set('a', 1);
st.cache.set('b', 2);
st.drop('a');
console.log('delete', st.cache.has('a'), st.cache.size, [...st.cache.keys()].join(','));

// index-type: a Record type for the indexed object.
const obj = { x: 1, y: 2 };
const table: Record<string, number> = obj;
for (const key of ['x', 'y', 'z']) console.log('index', key, table[key]);

// generic-any-argument: held with its own type argument.
class Box<T> { constructor(public value: T) {} map<U>(f: (v: T) => U): Box<U> { return new Box(f(this.value)); } }
const box: Box<number> = new Box<number>(1);
console.log('generic', box.map((v) => v + 1).value);
