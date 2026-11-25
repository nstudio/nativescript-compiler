// @lenient-both
// A read narrowed to a primitive still holds null or undefined in code checked without strictNullChecks (core's
// keyboardType setNative): its nullish test reads the stored value.
const log: string[] = [];
class Field {
  inputType = -1;
  setKeyboard(value: 'phone' | 'integer' | number): void {
    let next: number;
    switch (value) {
      case 'phone':
        next = 3;
        break;
      case 'integer':
        next = 2;
        break;
      default: {
        const n = value == null ? NaN : +value;
        next = isNaN(n) ? 1 : n;
        break;
      }
    }
    this.inputType = next;
  }
}
function flag(value: 'auto' | boolean): string {
  if (value === 'auto') return 'auto';
  return value != null ? `${!value}` : 'unset';
}
function label(value: 0 | string): string {
  if (value === 0) return 'zero';
  return value === undefined ? 'missing' : value === null ? 'none' : value.toUpperCase();
}
function count(value: 'none' | number): string {
  if (value === 'none') return '-';
  return `${value !== null}:${undefined == value}:${value === undefined ? 'u' : value == null ? 'n' : value + 1}`;
}
const field = new Field();
for (const value of ['phone', 'integer', 7, 0, null, undefined] as any[]) {
  field.setKeyboard(value);
  log.push(`${value}:${field.inputType}`);
}
for (const value of ['auto', true, false, null, undefined] as any[]) log.push(flag(value));
for (const value of [0, 'a', null, undefined] as any[]) log.push(label(value));
for (const value of ['none', 4, NaN, null, undefined] as any[]) log.push(count(value));
console.log(log.join(','));
