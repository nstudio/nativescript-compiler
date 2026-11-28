// @lenient-both
// Library mode: property-descriptor setter wrappers preserve `this` (JSMethod) across object literals and descriptor reassignments.
class StyleBox {
	id: string;
	values: Record<string, unknown> = {};
	vars: string[] = [];
	constructor(id: string) {
		this.id = id;
	}
}

function wrapSetter<T extends StyleBox>(cssName: string, set: (this: T, value: unknown) => void) {
	return function (this: T, value: unknown) {
		if (typeof value === 'string' && value.startsWith('var(')) {
			this.vars.push(`${this.id}:${cssName}=${value}`);
			return;
		}
		set.call(this, value);
	};
}

function setColorLocal(this: StyleBox, value: unknown) {
	this.values['color'] = `${this.id}:${value}`;
}

// Pattern 1: inline descriptor literal `{ set: wrapSetter(...) }` (CssProperty)
Object.defineProperty(StyleBox.prototype, 'color', {
	configurable: true,
	enumerable: true,
	get(this: StyleBox) {
		return this.values['color'];
	},
	set: wrapSetter('color', setColorLocal),
});

// Pattern 2: wrapping an existing PropertyDescriptor's `.set` directly (`CssAnimationProperty`)
Object.defineProperty(StyleBox.prototype, 'opacity', {
	configurable: true,
	enumerable: true,
	get(this: StyleBox) {
		return this.values['opacity'];
	},
	set(this: StyleBox, value: unknown) {
		this.values['opacity'] = `${this.id}:${value}`;
	},
});
const opacityDesc = Object.getOwnPropertyDescriptor(StyleBox.prototype, 'opacity');
opacityDesc.set = wrapSetter('opacity', opacityDesc.set);
Object.defineProperty(StyleBox.prototype, 'opacity', opacityDesc);

// Pattern 2b: wrapping an existing PropertyDescriptor's `.set` via an intermediate typed variable
Object.defineProperty(StyleBox.prototype, 'scale', {
	configurable: true,
	enumerable: true,
	get(this: StyleBox) {
		return this.values['scale'];
	},
	set(this: StyleBox, value: unknown) {
		this.values['scale'] = `${this.id}:${value}`;
	},
});
const scaleDesc = Object.getOwnPropertyDescriptor(StyleBox.prototype, 'scale');
const origScaleSet = scaleDesc.set;
scaleDesc.set = wrapSetter('scale', origScaleSet);
Object.defineProperty(StyleBox.prototype, 'scale', scaleDesc);

// Pattern 2c: wrapping a non-`this` arrow setter on a PropertyDescriptor
const plainSeen: string[] = [];
Object.defineProperty(StyleBox.prototype, 'plain', {
	configurable: true,
	enumerable: true,
	get: () => plainSeen[plainSeen.length - 1],
	set: (v: unknown) => {
		plainSeen.push(String(v));
	},
});
const plainDesc = Object.getOwnPropertyDescriptor(StyleBox.prototype, 'plain');
plainDesc.set = wrapSetter('plain', plainDesc.set);
Object.defineProperty(StyleBox.prototype, 'plain', plainDesc);

// Pattern 3: descriptor `.set` assigned a factory result (`InheritedCssProperty`)
function makeSetter(source: string) {
	return function (this: StyleBox, value: unknown) {
		this.values['fontSize'] = `${this.id}:${source}:${value}`;
	};
}
const fontDesc: PropertyDescriptor = {
	configurable: true,
	enumerable: true,
	get(this: StyleBox) {
		return this.values['fontSize'];
	},
};
fontDesc.set = wrapSetter('font-size', makeSetter('local'));
Object.defineProperty(StyleBox.prototype, 'fontSize', fontDesc);

const s1: any = new StyleBox('s1');
const s2: any = new StyleBox('s2');
s1.color = 'red';
s2.color = 'var(--c)';
s1.opacity = 0.5;
s2.opacity = 'var(--o)';
s1.scale = 2;
s2.scale = 3;
s1.plain = 'hello';
s2.plain = 'var(--p)';
s1.fontSize = 14;
s2.fontSize = 'var(--f)';

console.log('s1', s1.color, s1.opacity, s1.scale, s1.fontSize, s1.vars.join('|'));
console.log('s2', s2.color, s2.opacity, s2.scale, s2.fontSize, s2.vars.join('|'));
console.log('plain', plainSeen.join(','));
