// @plugin-both
// A plugin's guarded view of an object, revoked when its owner is done with it.
// @refused `Proxy` is a declared limit of release builds
export function guarded<T extends object>(target: T): { view: T; done: () => void } {
  const { proxy, revoke } = Proxy.revocable(target, {});
  return { view: proxy, done: revoke };
}

const g = guarded({ n: 1 });
console.log(g.view.n);
g.done();
