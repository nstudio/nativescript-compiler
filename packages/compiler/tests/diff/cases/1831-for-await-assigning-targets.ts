// `for await` and a lowered `for…of` writing each value to targets declared elsewhere: variables by a pattern, a member.
let x = 0, y = 0;
const o: { a?: number } = {};
async function* gen() {
  yield [1, 2];
  yield [3, 4];
}
async function run() {
  for await ([x, y] of gen()) console.log('pair', x, y);
  for await (o.a of [Promise.resolve(5), 6]) console.log('member', o.a);
  for ([x, y] of [[7, 8]]) console.log('sync', x, y);
  let z: number[] = [];
  for await (z of gen()) console.log("whole", z.join());
}
run().then(() => console.log('done', x, y));
