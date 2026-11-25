// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): `+`, `-`, `*` and unary `+`/`!` coercion of arrays, objects, booleans and strings.
const arr: any = [];
const obj: any = {};
const a = 'a' as any;
const bar = 'bar' as any;
const t: any = true;
console.log('"b" + "a" + +"a" + "a"', 'b' + 'a' + +a + 'a'); // wtfjs: baNaNa
console.log('"foo" + +"bar"', 'foo' + +bar); // wtfjs: baNaNa
console.log('fail', (!arr + arr)[+arr] + (!arr + arr)[+!+arr] + ([!arr] + arr[arr])[(+!+arr as any) + [+arr]] + (!arr + arr)[(!+arr as any) + !+arr]); // wtfjs: It's a fail
console.log('![] + []', !arr + arr); // wtfjs: It's a fail
console.log('"false"[0]', 'false'[0]); // wtfjs: It's a fail
console.log('+![]', +!arr); // wtfjs: It's a fail
console.log('+!![]', +!!arr); // wtfjs: It's a fail
console.log('[][[]]', arr[arr]); // wtfjs: It's a fail
console.log('+!![] / +![]', +!!arr / +!arr); // wtfjs: It's a fail
console.log('[] + {}', arr + obj); // wtfjs: It's a fail
console.log('+{}', +obj); // wtfjs: It's a fail
console.log('+[]', +arr); // wtfjs: Funny math
console.log('[1, 2, 3] + [4, 5, 6]', ([1, 2, 3] as any) + ([4, 5, 6] as any)); // wtfjs: Adding arrays
console.log('true + true', t + t); // wtfjs: Math with `true` and `false`
console.log('(true + true) * (true + true) - true', (t + t) * (t + t) - t); // wtfjs: Math with `true` and `false`
console.log('+true', +t); // wtfjs: Math with `true` and `false`
console.log('3 - 1', 3 - 1); // wtfjs: Funny math
console.log('3 + 1', 3 + 1); // wtfjs: Funny math
console.log('"3" - 1', ('3' as any) - 1); // wtfjs: Funny math
console.log('"3" + 1', '3' + 1); // wtfjs: Funny math
console.log('"" + ""', '' + ''); // wtfjs: Funny math
console.log('[] + []', arr + arr); // wtfjs: Funny math
console.log('{} + []', obj + arr); // wtfjs: Funny math
console.log('{} + {}', obj + obj); // wtfjs: Funny math
console.log('"222" - -"111"', ('222' as any) - -('111' as any)); // wtfjs: Funny math
console.log('[4] * [4]', ([4] as any) * ([4] as any)); // wtfjs: Funny math
console.log('[] * []', arr * arr); // wtfjs: Funny math
console.log('[4, 4] * [4, 4]', ([4, 4] as any) * ([4, 4] as any)); // wtfjs: Funny math
console.log('`${{ Object }}`', `${{ Object }}`); // wtfjs: `` `${{Object}}` ``
console.log('["property"] + ""', ['property'] + ''); // wtfjs: Accessing object properties with arrays

// Statically typed where TypeScript accepts the operands.
const xs: number[] = [1, 2, 3];
const ys: number[] = [4, 5, 6];
const s: string = 'bar';
const yes: boolean = true;
console.log('typed "foo" + +"bar"', 'foo' + +s); // wtfjs: baNaNa
console.log('typed [1, 2, 3] + "" + [4, 5, 6]', xs + '' + ys); // wtfjs: Adding arrays
console.log('typed +true', +yes); // wtfjs: Math with `true` and `false`
console.log('typed +!![] / +![]', +!!xs / +!xs); // wtfjs: It's a fail
console.log('typed "3" + 1', s.length + '' + 1); // wtfjs: Funny math
console.log('typed `${[1, 2, 3]}`', `${xs}`);
console.log('typed "" + {}', '' + {});
console.log('typed String([[null]])', String([[null]]));
