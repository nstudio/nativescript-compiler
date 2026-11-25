// A program class named as a native class's Swift name (NSThread is Swift's `Thread`), beside a program type named as
// that class's module: each name is the program's own, and the native class is still reached through its native name.
class Foundation { readonly kind = 'wrapper'; }
class Thread {
  constructor(readonly label: string) {}
  describe() { return `${this.label} thread`; }
}
const native = typeof NSThread !== 'undefined';
function onMain(): boolean {
  if (!native) return true;
  const current: NSThread = NSThread.currentThread;
  return current.isMainThread && NSThread.isMainThread;
}
const t = new Thread('worker');
console.log(t.describe(), t instanceof Thread, new Foundation().kind, onMain());
