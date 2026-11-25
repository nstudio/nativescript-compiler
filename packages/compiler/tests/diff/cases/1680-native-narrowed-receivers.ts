// @swift ledger:nativeSdk
// A native object the platform may give as nil, narrowed by `instanceof`: the narrowed read is the object, and a choice of
// nil-able objects returned or stored where nil is held goes as it is, nil included, as JavaScript returns null.
const MISSING = '/nonexistent/sq1-1680.bin';
function top(d: NSData): NSData {
  if (d.length > 100) return top(NSData.dataWithContentsOfFile(MISSING));
  if (d instanceof NSMutableData) {
    return d.length ? top(NSData.dataWithContentsOfFile(MISSING)) : d;
  }
  return d;
}
function len(d: NSData): number {
  if (!d) return -1;
  if (d instanceof NSMutableData) return d.length + 100;
  return d.length;
}
function chosen(d: NSData, empty: boolean): string {
  const pick = empty ? NSData.dataWithContentsOfFile(MISSING) : d;
  return pick ? `data ${pick.length}` : "none";
}
function read(d: NSData): string {
  try {
    return `${top(d).length}`;
  } catch (e) {
    return (e as Error).name;
  }
}
function pickTop(d: NSData, last: boolean): NSData {
  if (d instanceof NSMutableData) return last ? NSData.dataWithContentsOfFile(MISSING) : d;
  return d;
}
console.log(top(NSMutableData.dataWithLength(0)).length, top(NSData.data()).length, pickTop(NSMutableData.dataWithLength(2), true) ? "some" : "none", pickTop(NSMutableData.dataWithLength(2), false).length);
console.log(read(NSMutableData.dataWithLength(2)), read(NSMutableData.dataWithLength(0)), read(NSMutableData.dataWithLength(300)));
console.log(len(NSData.dataWithContentsOfFile(MISSING)), len(NSMutableData.dataWithLength(3)), len(NSData.data()));
console.log(chosen(NSMutableData.dataWithLength(4), false), chosen(NSData.data(), true));
