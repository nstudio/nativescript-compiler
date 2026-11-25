// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): String() called on a value held untyped.
const str: any = 'str';
console.log('typeof String("str")', typeof String(str)); // wtfjs: Strings aren't instances of `String`
console.log('String("str")', String(str)); // wtfjs: Strings aren't instances of `String`
console.log('String("str") == "str"', String(str) == 'str'); // wtfjs: Strings aren't instances of `String`
