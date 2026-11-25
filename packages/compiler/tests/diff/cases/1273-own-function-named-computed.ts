// A program's own function named `computed` is an ordinary call: it runs each time, and its result is a plain value.
function computed<T>(fn: () => T): T {
  console.log('own computed called');
  return fn();
}

const total = computed(() => [1, 2, 3].reduce((a, b) => a + b, 0));
console.log('total:', total, total + 1);

class Report {
  readonly lines = computed(() => ['x', 'y']);
  count() {
    return this.lines.length;
  }
}

const r = new Report();
r.lines.push('z');
console.log('lines:', r.lines.join(','), r.count());
function local() {
  const v = computed(() => ({ k: 1 }));
  v.k = 2;
  return v.k;
}
console.log('local:', local());
