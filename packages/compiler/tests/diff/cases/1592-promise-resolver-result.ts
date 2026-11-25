// A variable initialized null and assigned in a callback: a read after the callback ran holds what the callback
// wrote (a Promise executor's resolve and reject return undefined), though the checker narrows the read to null.
let fromResolve: unknown = null;
let fromReject: unknown = null;
let fromCallback: string | null | undefined = null;
function same(a: unknown, b: unknown, label: string): void {
  console.log(label, a === b, typeof a);
}
const p = new Promise<number>(function (resolve) {
  fromResolve = resolve(45);
});
const q = new Promise<number>(function (_resolve, reject) {
  fromReject = reject(new Error('no'));
});
[1].forEach(function (n) {
  fromCallback = n > 0 ? undefined : 'never';
});
same(fromResolve, undefined, 'resolve');
same(fromReject, undefined, 'reject');
same(fromCallback, undefined, 'callback');
p.then(function (v) { console.log('resolved', v); });
q.catch(function (e: Error) { console.log('rejected', e.message); });
