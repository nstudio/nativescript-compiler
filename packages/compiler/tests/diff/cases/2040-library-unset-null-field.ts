// @lenient-both
// Library mode: a string, number or boolean field declared without a value and written null is undefined (no key)
// until its first write, and null (a key) once written null, as Node holds it.
enum Size {
  NONE = 0,
  WIDTH = 1,
}
class Request {
  status: number;
  label: string;
  done: boolean;
  size: Size;
  open(code: number): void {
    this.status = code;
    this.label = 'open';
    this.done = false;
    this.size = Size.WIDTH;
  }
  reset(): void {
    this.status = null;
    this.label = null;
    this.done = null;
    this.size = null;
  }
  own(): string {
    return [this.status, this.status === undefined, typeof this.label, this.label == null].join('|');
  }
}
function show(r: Request): string {
  return [r.status, r.status === undefined, r.status === null, typeof r.status, String(r.status), r.status + 1, r.label, r.label === undefined, r.label == null, typeof r.label, `${r.label}`, r.label + '!', r.done, r.done === null, typeof r.done, r.size === Size.WIDTH, r.size === null, typeof r.size, JSON.stringify(r), Object.keys(r).join(','), r.own()].join('|');
}
const r = new Request();
console.log(show(r));
r.open(200);
console.log(show(r));
r.reset();
console.log(show(r));
r.open(404);
console.log(show(r));
const q = new Request();
q.status += 1;
const p = new Request();
p.reset();
p.status += 1;
p.label += '?';
console.log(q.status, p.status, p.label, JSON.stringify(p));
