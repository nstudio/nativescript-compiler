// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): an array literal with trailing commas and holes.
// @refused an array hole is not supported in a release build yet
const holes: any = [, , ,]; // wtfjs: Trailing commas in array
console.log('[, , ,].length', holes.length); // wtfjs: Trailing commas in array
console.log('[, , ,].toString()', holes.toString()); // wtfjs: Trailing commas in array
console.log('[,1].indexOf(undefined)', ([, 1] as any).indexOf(undefined), ([, 1] as any).includes(undefined));
