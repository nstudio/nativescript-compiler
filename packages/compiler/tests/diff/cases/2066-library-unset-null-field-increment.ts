// @lenient-both
// Library mode: `++`/`--` of a number field declared without a value and written null converts undefined (NaN) until
// its first write and null (0) once written null.
class Request {
  status: number;
  retries: number;
  reset(): void {
    this.status = null;
    this.retries = null;
  }
  bump(): number {
    return this.retries++;
  }
}
const q = new Request();
const a = q.status++;
const b = --q.retries;
console.log(a, q.status, b, q.retries, JSON.stringify(q));
const p = new Request();
p.reset();
const c = p.status++;
const d = ++p.retries;
console.log(c, p.status, d, p.retries, p.bump(), p.retries, JSON.stringify(p));
const n = new Request();
console.log(n.bump(), n.retries, typeof n.retries);
const m = new Request();
m.status++;
m.retries--;
console.log(m.status, m.retries, JSON.stringify(m));
m.reset();
m.status++;
m.retries--;
console.log(m.status, m.retries, JSON.stringify(m));
