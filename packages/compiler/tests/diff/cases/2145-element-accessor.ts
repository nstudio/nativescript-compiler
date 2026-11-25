// A getter defined on an array element with Object.defineProperty.
// @refused a getter or setter defined on an array element is not supported in a release build yet
const xs = [1, 2, 3];
let reads = 0;
Object.defineProperty(xs, '1', {
  get: () => {
    reads++;
    return 20;
  },
  configurable: true,
});
console.log(xs[1], xs.map((x) => x * 2), reads);
