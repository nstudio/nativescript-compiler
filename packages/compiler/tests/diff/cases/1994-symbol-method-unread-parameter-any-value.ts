// @lenient-both
// A symbol-keyed method whose body never reads a parameter takes any value there, as script never checks a declared
// type: core's `[backgroundInternalProperty.setNative](value: Color) {}` on Progress is given a Background.
class Property {
  readonly setNative: symbol;
  constructor(public name: string) {
    this.setNative = Symbol(name + ':setNative');
  }
}
const backgroundInternal = new Property('backgroundInternal');
const sizeProperty = new Property('size');
const colorProperty = new Property('color');

class Color {
  constructor(public hex: string) {}
}
class Background {
  color = new Color('#cfe0fa');
}

class View {
  log: string[] = [];
  applyNative(property: Property, value: any) {
    const setter = (this as any)[property.setNative];
    if (setter) {
      setter.call(this, value);
    }
  }
}

class Progress extends View {
  [backgroundInternal.setNative](value: Color) {
    //
  }
  [sizeProperty.setNative](value: number) {
    this.log.push('size set');
  }
  [colorProperty.setNative](value: Color) {
    this.log.push('color ' + value.hex);
  }
}

const p = new Progress();
p.applyNative(backgroundInternal, new Background());
p.applyNative(backgroundInternal, 'none');
p.applyNative(sizeProperty, {
  valueOf() {
    p.log.push('valueOf');
    return 3;
  },
});
p.applyNative(colorProperty, new Color('#2e8b57'));
console.log(p.log.join(', '));
