// @app-lenient
// A non-strict app's `Promise<void>` async functions returning `undefined` and `null` explicitly: awaiting gives
// that value.
async function done(): Promise<void> {
  await Promise.resolve(1);
  return undefined;
}

async function stop(early: boolean): Promise<void> {
  await Promise.resolve(1);
  if (early) return undefined;
  console.log('ran');
}

async function main() {
  const r = await done();
  console.log(r === undefined, typeof r);
  await stop(true);
  await stop(false);
}
main();
