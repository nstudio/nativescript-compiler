// @swift ledger:nativeSdk
// A new Foundation dictionary where script holds a dictionary, and one passed on where a native API takes a dictionary.
function copied(d?: NSDictionary<any, any>): number {
  const x: NSDictionary<any, any> = d ?? NSDictionary.new();
  return NSMutableDictionary.dictionaryWithDictionary(x).count;
}
function made(): number {
  return NSMutableDictionary.dictionaryWithDictionary(NSDictionary.new()).count;
}
function fromObject(o: { a: number; b: string }): number {
  return NSDictionary.dictionaryWithDictionary(o as any).count;
}
console.log(copied(), made(), fromObject({ a: 1, b: 'x' }), copied(NSDictionary.dictionaryWithDictionary({ k: 1 } as any)));
