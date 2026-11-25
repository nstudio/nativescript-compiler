// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): string, JSON and object-key quirks.
const prod: any = 'production';
const k: any = {};
console.log('JSON.stringify("production") === "production"', JSON.stringify(prod) === 'production'); // wtfjs: A stringified string
console.log('JSON.stringify("production")', JSON.stringify(prod)); // wtfjs: A stringified string
console.log('{ [{}]: {} }', { [k]: {} }); // wtfjs: Object as a key of object's property
console.log('({ [{}]: { [{}]: {} } }[{}][{}])', ({ [k]: { [k]: {} } } as any)[k][k]); // wtfjs: Object as a key of object's property
console.log('Object.keys({ [{}]: 1 })', Object.keys({ [k]: 1 }));
console.log('"\u00e9" vs "e\u0301"', ('\u00e9' as string) === 'e\u0301', '\u00e9'.length, 'e\u0301'.length);
console.log('"😀".length', '😀'.length, [...'😀'].length, '😀'.charCodeAt(0), '😀'.codePointAt(0));
console.log('"abc" < "abd"', ('abc' as any) < 'abd', ('B' as any) < 'a', ('10' as any) < '9', ('10' as any) < 9);
console.log('JSON.stringify edge', JSON.stringify({ u: undefined, f() {}, n: NaN, i: -Infinity }), JSON.stringify([undefined, () => 1]), JSON.stringify(undefined));

// Statically typed.
const s: string = 'production';
console.log('typed JSON.stringify(s) === s', JSON.stringify(s) === s, JSON.stringify(s).length); // wtfjs: A stringified string
const key: string = String({});
const o: Record<string, Record<string, object>> = { [key]: { [key]: {} } };
console.log('typed {}-keyed', Object.keys(o), o[key][key], key); // wtfjs: Object as a key of object's property
console.log('typed s[99]', s[99], s.at(-1), s.charAt(99), s.slice(-3), s.substring(5, 2), s.substr(-3, 2));
console.log('typed comparisons', 'abc' < 'abd', 'B' < 'a', '10' < '9', 'a'.localeCompare('b'));
console.log('typed repeat/pad', 'ab'.repeat(3), '5'.padStart(3, '0'), 'x'.padEnd(4, 'ab'));
console.log('typed replace', 'aaa'.replace('a', 'b'), 'aaa'.replaceAll('a', 'b'), 'a.b.c'.split('.', 2));
console.log('typed JSON.stringify edge', JSON.stringify({ n: NaN, i: Infinity, d: new Date(0) }), JSON.stringify('\u2028'), JSON.stringify({ a: [1, { b: 2 }] }, null, 2));
