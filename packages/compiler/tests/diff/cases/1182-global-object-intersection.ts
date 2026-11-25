// The global object typed with members of its own (`typeof globalThis & { … }`): those members are the global object's,
// read and written by name.
type Signals = { ready: boolean; count: number };
type RuntimeGlobal = typeof globalThis & { __APP_SIGNALS__?: Signals };

const runtimeGlobal = globalThis as RuntimeGlobal;

function signals(runtime: RuntimeGlobal = runtimeGlobal): Signals {
  if (!runtime.__APP_SIGNALS__) runtime.__APP_SIGNALS__ = { ready: false, count: 0 };
  return runtime.__APP_SIGNALS__;
}

const first = signals();
first.count++;
console.log(signals().count, (globalThis as any).__APP_SIGNALS__.ready);
