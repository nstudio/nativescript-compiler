// @experimental-decorators
// Property decorators shaped as NativeScript plugins write them: one that forwards a field to the instance's style
// object, and option-taking factories whose accessors keep the value under a private key, convert it and notify.
export const styleProperty = (target: Object, key: string | symbol) => {
  Object.defineProperty(target, key, {
    get() {
      return this.style[key];
    },
    set(newVal) {
      this.style[key] = newVal;
    },
    enumerable: true,
    configurable: true
  });
};

export interface ShapeOptions {
  converter?: Function;
  silent?: boolean;
}

function makeGetter(key, options: ShapeOptions) {
  const realKey = '_' + key.toString();
  return function () {
    return this[realKey];
  };
}

function makeSetter(key, options: ShapeOptions) {
  const realKey = '_' + key.toString();
  return function (newVal) {
    const oldValue = this[realKey];
    const actualVal = options.converter ? options.converter(newVal) : newVal;
    this[realKey] = actualVal;
    if (options.silent !== true) {
      this.notify(key, actualVal, oldValue);
    }
  };
}

function generate(target: object, key: string | symbol, options?: ShapeOptions) {
  Object.defineProperty(target, key, {
    get: makeGetter(key, options),
    set: makeSetter(key, options),
    enumerable: true,
    configurable: true
  });
}

function shapeProperty(converter, args) {
  if (args.length === 1 && typeof args[0] === 'object') {
    const options = args[0];
    if (!options.converter) {
      options.converter = converter;
    }
    return function (target: any, key?: string, descriptor?: PropertyDescriptor) {
      return generate(target, key, options);
    };
  } else {
    return generate(args[0], args[1], { converter });
  }
}

export function upperProperty(target: any, k?, desc?: PropertyDescriptor): any;
export function upperProperty(options: ShapeOptions): (target: any, k?, desc?: PropertyDescriptor) => any;
export function upperProperty(...args) {
  return shapeProperty((v) => (v ? String(v).toUpperCase() : null), args);
}
export function numberProperty(target: any, k?, desc?: PropertyDescriptor): any;
export function numberProperty(options: ShapeOptions): (target: any, k?, desc?: PropertyDescriptor) => any;
export function numberProperty(...args) {
  return shapeProperty((v) => parseFloat(v), args);
}

export class Style {
  rippleColor: string = 'none';
  elevation: number = 0;
}

export class Widget {
  style = new Style();
  @styleProperty rippleColor: string;
  @styleProperty elevation: number;
}

export class Shape {
  changes: string[] = [];
  notify(key: string, value: any, old: any) {
    this.changes.push(`${key}:${old}->${value}`);
  }
  @upperProperty fill: string;
  @upperProperty({ silent: true }) label: string;
  @numberProperty width: number;
  @numberProperty({ converter: (v) => Math.round(parseFloat(v)) }) height: number;
  @numberProperty({ silent: true }) scale: number = 1;
}
