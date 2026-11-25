// A generic function whose callback parameter takes a closure of the type parameter: the closure given to it is
// called with values of that type.
function waitFor<T>(set: (done: (value: T) => void) => void, fallback: T): T {
  let result = fallback;
  let settled = false;
  set((value: T) => {
    if (settled) return;
    settled = true;
    result = value;
  });
  return result;
}
console.log(waitFor<number>((done) => done(4), -1));
console.log(waitFor<string>((done) => { done('first'); done('second'); }, 'none'));
console.log(waitFor<string>(() => {}, 'none'));

function promised<T>(set: (done: (value: T) => void) => void): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    set((value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 5);
  });
}
promised<number>((done) => setTimeout(() => done(9), 1)).then((v) => console.log('settled', v));
promised<string>(() => {}).then((v) => console.log('timed out', v));
