// @swift ledger:nativeSdk
// An object made by script where a native API takes a C struct: the struct's fields read from it by name, converted as the runtime converts them.
function range(start: number, length: number) {
  return { location: start, length };
}
function cut(s: string, start: number, length: number): string {
  const r = range(start, length);
  return NSString.stringWithString(s).substringWithRange(r);
}
function from(start: number) {
  return { location: start, length: undefined as number | undefined };
}
function rest(s: string, start: number): string {
  return NSString.stringWithString(s).substringWithRange(from(start) as { location: number; length: number });
}
function direct(s: string): string {
  const r = { location: 1, length: 3 };
  return NSString.stringWithString(s).substringWithRange(r);
}
console.log(JSON.stringify([cut('hello', 1, 3), cut('hello', 1.9, 2.9), cut('hello', 2, NaN), rest('hello', 1), direct('native')]));
