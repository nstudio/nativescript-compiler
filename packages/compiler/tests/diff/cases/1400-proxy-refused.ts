// A context object forwarding reads and writes to whichever context is current, built from Proxy traps.
// @refused `Proxy` is a declared limit of release builds
let current: Record<string, unknown> = { name: 'first' };

function forwardingContext(): Record<string, unknown> {
  return new Proxy({}, {
    get: (_target, key) => current[key as string],
    set: (_target, key, value) => { current[key as string] = value; return true; },
  });
}

const ctx = forwardingContext();
console.log(ctx.name);
current = { name: 'second' };
console.log(ctx.name);
