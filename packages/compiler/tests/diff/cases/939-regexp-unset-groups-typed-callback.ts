// Refused: a function value whose element parameter is declared `string`, visiting strings a pattern's unset group may leave undefined.
// @refused a function whose element parameter is declared to hold no undefined
const first = (value: string, index: number) => value.slice(0, 1) + index;
console.log('a b'.split(/(x)? /).map(first).join());
