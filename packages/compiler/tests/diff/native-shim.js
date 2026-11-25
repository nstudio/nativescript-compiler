// What a case's native classes need under Node, as NativeScript's runtime provides it: `@NativeClass` and `NSObject.new()`.
globalThis.NativeClass = (cls) => cls;
globalThis.NSObject = class NSObject {
  static new() {
    return new this();
  }
};
// A native protocol, as the runtime gives script one to list in `ObjCProtocols`.
globalThis.NSCacheDelegate = { prototype: {} };
// An error no script code caught, as NativeScript reports it under uncaughtErrorPolicy "report": to the handler a case
// sets (`globalThis.__onUncaughtError`, where core's is), and the program goes on. Without one, Node's own behavior.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    const handler = globalThis.__onUncaughtError;
    if (typeof handler !== 'function') {
      console.error(event === 'unhandledRejection' ? 'Uncaught (in promise)' : 'Uncaught', error);
      process.exit(1);
    }
    handler(error);
  });
}
// The Foundation and CoreGraphics APIs cases call, as script sees them through NativeScript's iOS runtime: a number
// passed where a native integer is taken is truncated toward zero and clamped to its range (NaN 0, as the runtime's
// conversion compiles on arm64), a float rounded to single precision; a struct is filled from the object's fields of
// its names, each converted so; a native number returned is a number. Java's classes, as the Android runtime marshals:
// an int through a long (wrapping past its range), a float rounded to single precision (NaN stays NaN).
const nativeNumber = (v) => { const n = Number(v); return Number.isNaN(n) ? 0 : n; };
const nativeInteger = (v, min, max) => { const n = nativeNumber(v); return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : 0; };
const nsInteger = (v) => nativeInteger(v, -(2 ** 63), 2 ** 63 - 1);
const nsUInteger32 = (v) => nativeInteger(v, 0, 2 ** 32 - 1);
globalThis.NSComparisonResult = { OrderedAscending: -1, OrderedSame: 0, OrderedDescending: 1 };
globalThis.NSString = {
  stringWithString: (s) => ({
    substringWithRange: (r) => s.substr(nsInteger(r.location), nsInteger(r.length)),
    compare: (o) => (s < o ? -1 : s > o ? 1 : 0),
  }),
};
globalThis.CGSizeEqualToSize = (a, b) => nativeNumber(a.width) === nativeNumber(b.width) && nativeNumber(a.height) === nativeNumber(b.height);
globalThis.CGRectGetMaxX = (r) => nativeNumber(r.origin?.x) + nativeNumber(r.size?.width);
// Foundation's collections, as script sees them: a dictionary's missing key is null, NSNull its own object.
globalThis.NSNull = class NSNull {
  static null() {
    return (NSNull.shared ??= new NSNull());
  }
};
globalThis.NSArray = class NSArray {
  constructor(items = []) {
    this.items = items;
  }
  static arrayWithArray(a) {
    return new this([...(a.items ?? a)]);
  }
  get count() {
    return this.items.length;
  }
  objectAtIndex(i) {
    return this.items[nsInteger(i)];
  }
};
globalThis.NSDictionary = class NSDictionary {
  constructor(entries = new Map()) {
    this.entries = entries;
  }
  static new() {
    return new this();
  }
  static dictionaryWithDictionary(d) {
    return new this(d instanceof NSDictionary ? new Map(d.entries) : new Map(Object.entries(d)));
  }
  static dictionaryWithObjectsForKeys(values, keys) {
    return new this(new Map(keys.items.map((k, i) => [k, values.items[i]])));
  }
  get count() {
    return this.entries.size;
  }
  // Foundation's order of keys is its own (hashed), not insertion: no case may depend on this one.
  get allKeys() {
    return new NSArray([...this.entries.keys()]);
  }
  objectForKey(k) {
    return this.entries.has(k) ? this.entries.get(k) : null;
  }
};
globalThis.NSMutableDictionary = class NSMutableDictionary extends globalThis.NSDictionary {};
// A set's order is Foundation's own (hashed), as a dictionary's keys are: no case may depend on this one.
globalThis.NSSet = class NSSet {
  constructor(items = []) {
    this.items = [...new Set(items)];
  }
  get count() {
    return this.items.length;
  }
  get allObjects() {
    return new NSArray([...this.items]);
  }
};
globalThis.NSOrderedSet = class NSOrderedSet {
  constructor(items = []) {
    this.items = [...new Set(items)];
  }
  static orderedSetWithArray(a) {
    return new this(a.items ?? a);
  }
  get count() {
    return this.items.length;
  }
  get set() {
    return new NSSet(this.items);
  }
};
globalThis.NSOperationQueue = {
  new() {
    let count = -1;
    return { get maxConcurrentOperationCount() { return count; }, set maxConcurrentOperationCount(v) { count = nsInteger(v); } };
  },
};
// A URL Foundation cannot parse (an unclosed IPv6 host, `http://[`) is nil, which script reads as null.
globalThis.NSURL = { URLWithString: (s) => (/\[[^\]]*$/.test(s) ? null : { absoluteString: s }) };
// Data from a path that doesn't exist is nil (the cases read no real file).
globalThis.NSData = class NSData {
  constructor(length = 0) {
    this._length = length;
  }
  static data() {
    return new this();
  }
  static dataWithContentsOfFile() {
    return null;
  }
  get length() {
    return this._length;
  }
};
globalThis.NSMutableData = class NSMutableData extends globalThis.NSData {
  static dataWithLength(n) {
    return new this(nsInteger(n));
  }
};
globalThis.NSNumber = { numberWithFloat: (f) => Math.fround(nativeNumber(f)), numberWithUnsignedInt: (n) => nsUInteger32(n), numberWithLongLong: (n) => nsInteger(n) };
const javaLong = (v) => BigInt(nativeInteger(v, -(2 ** 63), 2 ** 63 - 1));
const floatBits = (f) => new Int32Array(new Float32Array([Number(f)]).buffer)[0];
globalThis.java = {
  lang: {
    Integer: { toHexString: (n) => (Number(BigInt.asIntN(32, javaLong(n))) >>> 0).toString(16) },
    Long: { toHexString: (n) => BigInt.asUintN(64, javaLong(n)).toString(16) },
    Float: { floatToIntBits: floatBits },
  },
};
