// A promise handler giving an object literal, or a function's object of an inferred shape, awaited and read by its keys.
function m(keys: string[]) { return { ok: keys.length > 1, keys }; }
async function main() {
  const r = await Promise.resolve(['a', 'b']).then((keys) => ({ ok: keys.length > 1, keys }));
  console.log(r.ok, r.keys.join(','));
  const s = await Promise.resolve(['a']).then((keys) => m(keys));
  console.log(s.ok);
}
main();
