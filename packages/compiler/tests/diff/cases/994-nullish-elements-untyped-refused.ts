// Refused: an array whose elements are kept apart as null and undefined, given where its type isn't known (untyped code
// may write any value into it).
// @refused an array, Map or Set whose elements may be null or undefined both
const items: (string | null | undefined)[] = ['a', null, undefined];
function poke(a: any) {
  a[0] = 5;
}
poke(items);
console.log(items[0], items[1] === null, items[2] === undefined);
