// @plugin-both
// A non-strict plugin's async functions return another function's promise, as @nativescript-community/perms does:
// an async function's own promise, and a plain function's, which lenient code holds optional.
import { Perms, request } from './helpers/plugin/perms.ts';

async function main() {
  console.log(await Perms.getStatus());
  console.log(await Perms.request());
  console.log(await request('notification'));
  console.log(await request('camera'));
}
main();
