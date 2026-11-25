// @lenient-both
// A field under a registered property's name, read again after each change that can change what it reads: the
// property registered after reads, its accessor redefined, removed and given again, a subclass's prototype taking
// the name over, instances of two classes read in turn, the instance's own property under the name, and deletes.
class CssProperty {
  public readonly name: string;
  public readonly key: symbol;
  public readonly defaultValue: any;

  constructor(options: { name: string; defaultValue?: any }) {
    this.name = options.name;
    this.key = Symbol(options.name + ':propertyKey');
    this.defaultValue = options.defaultValue;
  }

  register(cls: { prototype: any }): void {
    const key = this.key;
    const defaultValue = this.defaultValue;
    Object.defineProperty(cls.prototype, this.name, {
      get() {
        return key in this ? this[key] : defaultValue;
      },
      set(value) {
        this[key] = value;
      },
      enumerable: true,
      configurable: true,
    });
  }
}

class Style {
  color: string;
  width: number;
  margin: string;
  tag: any;
}
class FancyStyle extends Style {}

const colorProperty = new CssProperty({ name: 'color', defaultValue: 'black' });
const widthProperty = new CssProperty({ name: 'width', defaultValue: 10 });
const marginProperty = new CssProperty({ name: 'margin' });
const tagProperty = new CssProperty({ name: 'tag' });
colorProperty.register(Style);
widthProperty.register(Style);

const s = new Style();
const f = new FancyStyle();
const both = [s, f, s, f];
const colors = () => both.map((x) => x.color || 'unset').join();
console.log('a', s.color, s.width, s.margin || 'unset', s.tag, f.color, f.margin || 'unset', f.tag);
s.color = 'red';
f.width = 20;
console.log('b', s.color, f.color, s.width, f.width, colors());
marginProperty.register(Style);
tagProperty.register(Style);
console.log('c', s.margin || 'unset', f.margin || 'unset', s.tag, f.tag);
s.margin = '4';
s.tag = 'ok';
console.log('d', s.margin, f.margin || 'unset', s.tag, f.tag);
Object.defineProperty(Style.prototype, 'color', {
  get() {
    return 'redefined';
  },
  configurable: true,
});
console.log('e', s.color, f.color, colors());
delete (Style.prototype as any).color;
console.log('f', s.color || 'unset', f.color || 'unset', colors());
colorProperty.register(Style);
console.log('g', s.color, f.color, colors());
Object.defineProperty(FancyStyle.prototype, 'color', {
  get() {
    return 'fancy';
  },
  configurable: true,
});
console.log('h', s.color, f.color, colors());
const s2 = new Style();
Object.defineProperty(s2, 'color', { value: 'own', configurable: true, writable: true });
console.log('i', s.color, s2.color, f.color, colors());
delete (s as any)[colorProperty.key];
delete (FancyStyle.prototype as any).color;
console.log('k', s.color, f.color, s.width, f.width, colors());
