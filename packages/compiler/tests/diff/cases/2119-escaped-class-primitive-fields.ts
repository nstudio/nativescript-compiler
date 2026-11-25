// Opened app-class writable primitive fields (escaped through `any`, dynamic key, `Object.assign`, `Object.defineProperty`) hold undefined as T? matching Node.
class Box {
	label: string = 'init';
	count: number = 10;
	active: boolean = true;
	readonly fixed: string = 'keep';
}

const b1 = new Box();
const a1: any = b1;
a1.label = undefined;
a1.count = undefined;
a1.active = undefined;
console.log('any-write', b1.label, b1.label === undefined, typeof b1.label, String(b1.label), b1.count, b1.count === undefined, b1.count + 1, b1.active, b1.active === undefined, b1.active ? 'y' : 'n', b1.fixed);
console.log('any-read', a1.label === undefined, a1.count === undefined, a1.active === undefined, JSON.stringify(b1));
b1.label = 'restored';
b1.count = 42;
b1.active = true;
console.log('restored', b1.label, b1.count, b1.active);

const b2 = new Box();
const k1: string = 'label';
const k2: string = 'count';
(b2 as any)[k1] = undefined;
(b2 as any)[k2] = undefined;
console.log('dynamic-key', b2.label === undefined, b2.label ?? 'fallback', b2.count === undefined, b2.count ?? -1);

class Assigned {
	title: string = 'a';
	rank: number = 1;
	flag: boolean = true;
}
const asg = new Assigned();
Object.assign(asg, { title: undefined, rank: undefined, flag: undefined });
console.log('assign', asg.title === undefined, typeof asg.title, asg.rank === undefined, asg.flag === undefined, Object.keys(asg).join(','));

class Defined {
	name: string = 'r';
	score: number = 5;
}
const def = new Defined();
Object.defineProperty(def, 'name', { value: undefined });
Object.defineProperties(def, { score: { value: undefined } });
console.log('define', def.name === undefined, def.score === undefined);

class ParamBox {
	constructor(
		public tag: string,
		public total: number,
		public ok: boolean,
	) {}
}
const pb = new ParamBox('p', 3, true);
const apb: any = pb;
apb.tag = undefined;
apb.total = undefined;
apb.ok = undefined;
console.log('param-prop', pb.tag === undefined, pb.total === undefined, pb.ok === undefined, pb.tag ?? 'none');

class BaseItem {
	code: string = 'base';
}
class SubItem extends BaseItem {
	extra: number = 9;
}
const sub = new SubItem();
const asub: any = sub;
asub.code = undefined;
asub.extra = undefined;
console.log('subclass', sub.code === undefined, sub.extra === undefined);

class Closed {
	label: string = 'closed';
	count: number = 7;
	active: boolean = false;
}
const cl = new Closed();
console.log('closed', cl.label, cl.count, cl.active);
