// A promise of undefined held untyped among other values: it settles with undefined.
async function main(): Promise<void> {
  const loads: any[] = [Promise.resolve(undefined), Promise.resolve(1)];
  const done = await Promise.all(loads);
  console.log(done.length, done[0], done[1], typeof done[0]);
  const one: any = Promise.resolve(undefined);
  console.log(await one);
}
main();
