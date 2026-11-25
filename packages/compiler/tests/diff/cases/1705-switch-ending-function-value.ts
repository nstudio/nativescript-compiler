// A switch without fallthrough ending a function value that may give a value (`unknown`, `any`): JavaScript gives
// undefined, never the last clause's value; and one ending a callback.
function last(x: string): number {
  return x.length;
}
const ends: (x: string) => unknown = (x) => {
  switch (x) {
    case 'a':
      last(x);
      break;
    default:
      last(x + x);
  }
};
const endsAny = (x: string): any => {
  switch (x) {
    case 'a':
      last(x);
      break;
    default:
      last(x + x);
  }
};
console.log(ends('a'), ends('b'), endsAny('a'), endsAny('b'));
['p', 'q'].forEach((x) => {
  switch (x) {
    case 'p':
      console.log('each p');
      break;
  }
});
