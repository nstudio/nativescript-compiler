// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): spread, arrays as property keys, splitting the empty string and sorting typed arrays.
console.log('[...[..."..."]].length', [...[...('...' as any)]].length); // wtfjs: Dots and spreading
console.log('[..."..."]', [...('...' as any)]); // wtfjs: Dots and spreading
const obj: any = { property: 1 };
const keyArr: any = ['property'];
console.log('obj[["property"]]', obj[keyArr]); // wtfjs: Accessing object properties with arrays
const nestedArr: any = [[[[[[[[[['property']]]]]]]]]];
console.log('obj[nestedArray]', obj[nestedArr]); // wtfjs: Accessing object properties with arrays
const map: any = {};
const x: any = 1;
const y: any = 2;
const z: any = 3;
map[[x, y, z] as any] = true; // wtfjs: Accessing object properties with arrays
map[[x + 10, y, z] as any] = true; // wtfjs: Accessing object properties with arrays
console.log('map["1,2,3"]', map['1,2,3']); // wtfjs: Accessing object properties with arrays
console.log('map["11,2,3"]', map['11,2,3']); // wtfjs: Accessing object properties with arrays
console.log('Object.keys(map)', Object.keys(map));
console.log('"".split("")', ('' as any).split('')); // wtfjs: Split a string by a space
console.log('"".split(" ")', ('' as any).split(' ')); // wtfjs: Split a string by a space
console.log('[1, 2, 3].length = 1', ((a: any) => { a.length = 1; return a; })([1, 2, 3]));
console.log('Array(3)', (Array as any)(3).length, (Array as any)(3, 4), (Array as any)('3'));

// Statically typed.
const ns: number[] = [10, 1, 3];
console.log('typed [10, 1, 3].sort()', ns.slice().sort(), ns.slice().sort((a, b) => a - b)); // wtfjs: Default behavior Array.prototype.sort()
const words: string[] = ['b', 'B', 'a', '10', '9'];
console.log('typed string sort', words.sort());
const typedHoles: number[] = [];
typedHoles.length = 3;
console.log('typed holes', typedHoles.length, typedHoles.toString(), typedHoles.join('-'));
console.log('typed [..."..."]', [...[...'...']].length, [...'...']); // wtfjs: Dots and spreading
const typedObj: Record<string, number> = { property: 1 };
console.log('typed obj[String(["property"])]', typedObj[String(['property'])]); // wtfjs: Accessing object properties with arrays
const typedMap: Record<string, boolean> = {};
const a: number = 1;
typedMap[String([a, 2, 3])] = true;
typedMap[`${[a + 10, 2, 3]}`] = true;
console.log('typed map', typedMap['1,2,3'], typedMap['11,2,3'], Object.keys(typedMap)); // wtfjs: Accessing object properties with arrays
const emptyS: string = '';
console.log('typed "".split', emptyS.split(''), emptyS.split(' '), 'a,b,'.split(',')); // wtfjs: Split a string by a space
console.log('typed ["1", "2", "3"].map(parseInt)', ['1', '2', '3'].map((s, i) => parseInt(s, i)));
console.log('typed [1, [2, [3]]].toString()', [1, [2, [3]]].toString(), String([null, undefined, 1]));
