// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): the default sort of an array held untyped, which compares elements as strings.
const nums: any = [10, 1, 3];
console.log('[10, 1, 3].sort()', nums.sort()); // wtfjs: Default behavior Array.prototype.sort()
console.log('[10, 1, 3].sort((a, b) => a - b)', ([10, 1, 3] as any).sort((a: any, b: any) => a - b)); // wtfjs: Default behavior Array.prototype.sort()
console.log('mixed sort', ([10, 'b', 2, undefined, 'a', null, 1] as any).sort());
