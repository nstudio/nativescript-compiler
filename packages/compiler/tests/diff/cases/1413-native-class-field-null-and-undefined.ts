// @swift ledger:nativeSdk
// A native class's fields declared without a value and later set to null: undefined, then the value, then null, each
// told apart, read by name as well, and the function field called through `?.` only while it holds one.
@NativeClass
class Sensor extends NSObject {
  onFire: (() => void) | null | undefined;
  label: string | null | undefined;

  fire(): string {
    this.onFire?.();
    return this.onFire === undefined ? 'undefined' : this.onFire === null ? 'null' : 'set';
  }
}

let fired = 0;
const s = Sensor.new() as Sensor;
const read = (o: any) => o.label;
console.log('unset', s.fire(), s.label === undefined, s.label === null, read(s) === undefined);
s.onFire = () => {
  fired++;
};
s.label = 'on';
console.log('set', s.fire(), fired, s.label, read(s));
s.onFire = null;
s.label = null;
console.log('cleared', s.fire(), fired, s.label === null, s.label === undefined, read(s) === null);
