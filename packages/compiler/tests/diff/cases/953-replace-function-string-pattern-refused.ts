// A replacement that may be a function, for a pattern that may be a string: a function is called per match with the
// match, each group, the offset and the whole string; any other value replaces by its string, `$` patterns included.
const pattern: string | RegExp = 'abc'.length > 9 ? /b/ : 'b';
console.log('abc'.replace(pattern, (m: string) => m.toUpperCase()));

const args = (...a: unknown[]) => JSON.stringify(a);
console.log('string first', 'a-b-a'.replace('a', args), 'a-b-a'.replace('zz', args));
console.log('string all', 'a-b-a'.replaceAll('a', args), 'aaa'.replaceAll('', (m: string, at: number) => `[${at}]`));
const regexp: string | RegExp = 'abc'.length < 9 ? /(a)(x)?/g : 'a';
console.log('regexp', 'a-b-a'.replace(regexp, args), 'a-b-a'.replaceAll(regexp, (m: string, g1: string, g2: unknown, at: number) => `${g1}${g2}${at}`));

const untyped: any = 'b';
const lenient: any = (m: string, at: number, s: string) => `<${m}@${at}/${s.length}>`;
const text: any = '[$&|$`|$\'|$$]';
console.log('untyped', 'abcb'.replace(untyped, lenient), 'abcb'.replaceAll(untyped, lenient), 'abcb'.replace(untyped, text), 'abcb'.replaceAll(untyped, text));
console.log('untyped regexp', 'abcb'.replace(/b/g, lenient), 'abcb'.replace(/(b)/, text), 'abcb'.replace(/c/, untyped));
const missing: any = undefined;
console.log('non-function', 'abcb'.replace('b', missing), 'abcb'.replaceAll(untyped, 7 as any));
const loose: any = 'x'.length > 9 ? /c/ : 'c';
console.log('asserted', 'abc'.replace(loose as { [Symbol.replace](s: string, r: (m: string) => string): string }, (m: string) => m + m));
try {
  'aba'.replaceAll(/a/ as string | RegExp, args);
} catch (e) {
  console.log('non-global', e instanceof TypeError);
}
