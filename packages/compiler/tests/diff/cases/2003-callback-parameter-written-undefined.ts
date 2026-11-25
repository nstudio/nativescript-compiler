// @lenient-both
// A function parameter written `T | undefined` in code checked without strictNullChecks takes undefined (core's oneShotCompletion).
const log: string[] = [];
export function once(handler: ((handled: boolean) => void) | undefined): (handled: boolean) => void {
  let done = false;
  return (handled: boolean) => {
    if (done) return;
    done = true;
    handler?.(handled);
    log.push(`once:${handled}:${handler === undefined}`);
  };
}
function deliver(name: string, handler: ((handled: boolean) => void) | undefined): void {
  log.push(`${name}:${typeof handler}`);
  handler?.(true);
  const report = once(handler);
  report(false);
  report(true);
}
function settle(value: number, done: ((n: number) => void) | null): boolean {
  if (done) done(value);
  return done === null;
}
deliver('launch', undefined);
deliver('action', (handled) => log.push(`handled:${handled}`));
log.push(`settle:${settle(1, null)}:${settle(2, (n) => log.push(`n:${n}`))}`);
console.log(log.join(','));
