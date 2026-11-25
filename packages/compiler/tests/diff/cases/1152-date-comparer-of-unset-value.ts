// @lenient-both
// A property's date comparer (core's date-picker) called through its options with the unset value first: false, as NaN
// compares, so the first date set is a change.
const dateComparer = (x: Date, y: Date): boolean => x <= y && x >= y;
class Prop {
  private value: any;
  constructor(private options: any) {}
  set(v: any): boolean {
    const changed = !this.options.equalityComparer(this.value, v);
    if (changed) this.value = v;
    return changed;
  }
  get(): any {
    return this.value;
  }
}
const min = new Prop({ name: 'minDate', equalityComparer: dateComparer });
const d = new Date(2026, 10, 3);
console.log(min.set(d), min.set(new Date(2026, 10, 3)), min.set(new Date(2030, 7, 1)), (min.get() as Date).getFullYear());
console.log(dateComparer(d, new Date(2026, 10, 3)), dateComparer(d, new Date(2030, 7, 1)));
