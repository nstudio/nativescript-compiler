// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a string's `constructor` property.
const str: any = 'str';
const s: string = 'str';
console.log('c[c]', str.constructor === String, ('constructor' as any)['constructor'] === String); // wtfjs: A `constructor` property
console.log('typed "constructor".constructor', s.constructor === String, s.constructor.name); // wtfjs: A `constructor` property
