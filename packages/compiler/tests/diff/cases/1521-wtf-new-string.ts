// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a String object made with `new`, against the string it wraps.
// @refused a wrapper object (new String) is not supported in a release build yet
const str: any = 'str';
const s: string = 'str';
console.log('new String("str") == "str"', new String(str) == 'str'); // wtfjs: Strings aren't instances of `String`
console.log('new String("str") === "str"', new String(str) === 'str'); // wtfjs: Strings aren't instances of `String`
console.log('typeof new String("str")', typeof new String(str)); // wtfjs: Strings aren't instances of `String`
console.log('new String("str")', new String(str)); // wtfjs: Strings aren't instances of `String`
console.log('typed typeof "str"', typeof s, typeof String(s), typeof new String(s)); // wtfjs: Strings aren't instances of `String`
console.log('typed new String == "str"', new String(s) == s, new String(s) === s, new String(s).valueOf() === s); // wtfjs: Strings aren't instances of `String`
