// @lenient
// @swift ledger:nativeSdk
// A native member Swift has as a `Set` that TypeScript reads as `NSSet` (core's `connectionOptions?.userActivities?.allObjects`):
// the class's members read past it, in an optional chain and outside one.
function chained(o: NSOrderedSet<string> | undefined): number {
  const all = o?.set?.allObjects;
  return all ? all.count : -1;
}
function counted(o: NSOrderedSet<string> | undefined): number {
  return o?.set?.count ?? -1;
}
function direct(o: NSOrderedSet<string>): number {
  return o.set.allObjects.count;
}
const o = NSOrderedSet.orderedSetWithArray(['a', 'b', 'b', 'c']);
console.log(chained(o), chained(undefined), counted(o), counted(undefined), direct(o), o.set.count);
