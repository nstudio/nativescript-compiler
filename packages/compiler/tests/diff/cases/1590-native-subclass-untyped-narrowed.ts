// @swift ledger:nativeSdk
// Untyped values tested by instanceof against an app class extending a native one, and passed where it is the
// parameter's type: each reads as that class.
@NativeClass
class Marker extends NSObject {
  label(): string {
    return 'marker';
  }
}

function describe(m: Marker): string {
  return m.label();
}

const values: any[] = [Marker.new(), 'text', 3, null];
for (const v of values) {
  if (v instanceof Marker) console.log('narrowed', v.label());
  else console.log('other', v === null ? 'null' : typeof v);
}
const held: any = values[0];
console.log('passed', describe(held));
for (const wrong of [values[1], values[3]]) {
  try {
    console.log('wrong', describe(wrong));
  } catch (e) {
    console.log('wrong threw', e instanceof TypeError);
  }
}
