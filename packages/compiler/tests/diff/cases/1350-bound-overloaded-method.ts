// An overloaded method read through `.bind`, the bound function kept in a variable and called with fewer arguments
// than the implementation declares, then wrapped and put back on the instance.
interface Action {
  type: string;
}

class Store {
  log: string[] = [];
  dispatch(action: Action): void;
  dispatch(make: () => Action, config?: { label: string }): number;
  dispatch(actionOrMake: Action | (() => Action), config?: { label: string }): number | void {
    const action = typeof actionOrMake === 'function' ? actionOrMake() : actionOrMake;
    this.log.push(`${action.type}${config ? `@${config.label}` : ''}`);
    if (typeof actionOrMake === 'function') return this.log.length;
  }
}

const store = new Store();
const original = store.dispatch.bind(store);
original({ type: 'first' });
const wrapped = (action: any) => original(action);
wrapped({ type: 'second' });
function run<T>(fn: () => T): T {
  return fn();
}
const guarded = (action: any) => (store.log.length > 5 ? original(action) : run(() => original(action)));
guarded({ type: 'third' });
console.log(store.log.join(','));
