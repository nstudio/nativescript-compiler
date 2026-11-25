// `for await` over a module's async generator: the generator the module's initializer made.
let count = 0;
const asyncIter = (async function* () {
  yield* [[1, 2, 3]];
})();
async function fn() {
  for await (const [x, y, z] of asyncIter) {
    console.log(x, y, z);
    count += 1;
  }
}
fn().then(() => console.log('count', count));
