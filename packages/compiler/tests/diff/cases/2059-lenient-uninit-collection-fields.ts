// @app-lenient
class Holder {
	items: string[];
	map: Map<string, number>;
	set: Set<number>;
}
const x = new Holder();
console.log(x.items === undefined, typeof x.items, x.map === undefined, typeof x.map, x.set === undefined, typeof x.set);
console.log(JSON.stringify(x), Object.keys(x).join());
x.items = ['a'];
x.map = new Map([['k', 1]]);
x.set = new Set([2]);
console.log(JSON.stringify(x), Object.keys(x).join(), x.items.length, x.map.get('k'), x.set.has(2));
class Part {
	n = 1;
}
class Owner {
	part: Part;
	list: number[];
	constructor() {
		this.list = [];
	}
}
const o = new Owner();
console.log(typeof o.part, typeof o.list, o.part === undefined);
o.part = new Part();
console.log(typeof o.part, typeof x.items, o.part.n);
