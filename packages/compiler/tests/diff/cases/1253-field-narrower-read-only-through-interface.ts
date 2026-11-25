// A class field narrower than its interface's optional member, never written through the interface: reads give the
// field's value through either name.
interface Named {
  name?: string;
}
class Item implements Named {
  name = 'item';
}
function show(n: Named): string {
  return n.name ?? 'none';
}
const i = new Item();
i.name = 'renamed';
console.log(show(i), i.name.toUpperCase(), show({}));
