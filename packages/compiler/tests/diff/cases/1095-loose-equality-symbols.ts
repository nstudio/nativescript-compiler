// `==` with a symbol on one side: a symbol equals only itself, or an object whose ToPrimitive gives it.
const symbols: symbol[] = [Symbol('s'), Symbol('s')];
const s: any = symbols[0];
const t: any = symbols[1];
const others: any[] = ['abc', '', 's', 'Symbol(s)', 0, 1, NaN, true, false, 10n, null, undefined, t, [], ['s'], {}];
for (const o of others) console.log(typeof o, o == s, s == o, o != s, s != o);
console.log(s == s, s != s, s == t);

const viaValueOf: any = { valueOf: () => s };
class ToSymbol {
  [Symbol.toPrimitive](hint: string) {
    return s;
  }
}
const viaToPrimitive: any = new ToSymbol();
const viaToString: any = { toString: () => 'Symbol(s)' };
console.log(viaValueOf == s, s == viaValueOf, viaToPrimitive == s, s != viaToPrimitive, viaToString == s, s == viaToString);

// A bigint against an object compares with the object's primitive.
const big: any = 1n;
const objects: any[] = [[1], ['1'], [], { valueOf: () => 1n }, { valueOf: () => 1 }, { toString: () => '1' }, { valueOf: () => 2n }, {}];
console.log(objects.map((o) => [o == big, big == o, o != big].join(' ')).join(' | '));
