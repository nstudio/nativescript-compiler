// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): class fields with no semicolons, where ASI does not split them.
const empty: any = [];
class SomeClass {
  ['array'] = empty // wtfjs: Why you should use semicolons
  ['string'] = 'str'; // wtfjs: Why you should use semicolons
}
const some: any = new SomeClass();
console.log('new SomeClass().array', some.array, Object.keys(some), empty.string); // wtfjs: Why you should use semicolons
