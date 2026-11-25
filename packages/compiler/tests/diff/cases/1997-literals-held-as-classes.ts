// @lenient-both
// Library mode: an object literal held without a type (a const, a map's result, a field of another such literal) where
// only one of the program's classes is taken is made as that class's object, the same object wherever it goes.
interface Declaration {
	type: string;
	property: string;
	value: string;
}
class Decl {
	property: string;
	value: any;
}
class Info {
	duration: number;
	declarations: Array<Decl>;
	curve?: any = 'ease';
}
class Unparsed {
	values: Array<any>;
	declarations: Array<Decl>;
}
function names(decls: Decl[]): string {
	return decls.map((d) => `${d.property}=${d.value}`).join(',');
}
function frames(infos: Info[]): string {
	const all = infos.slice();
	const implicit = new Array<Info>();
	if (all[0].duration > 0) {
		const from = { duration: 0, declarations: [] };
		implicit.push(from);
		all.unshift(from);
		from.duration = 0.25;
	}
	if (all[all.length - 1].duration < 1) {
		const to = { duration: 1, declarations: [{ property: 'opacity', value: 1 }] };
		implicit.push(to);
		all.push(to);
	}
	const marks = all.map((f) => `${f.duration}:${implicit.includes(f)}:${all.indexOf(f)}:${f.curve}:${names(f.declarations)}`);
	return `${marks.join(' ')} ${implicit[0] === all[0]} ${implicit[1] === all[all.length - 1]} ${JSON.stringify(implicit)}`;
}
console.log(frames([{ duration: 0.5, declarations: [] }]));
function evaluate(list: Unparsed[], scale: number): Unparsed[] {
	let unparsed = list;
	if (scale) {
		unparsed = unparsed.map((k) => ({ values: k.values, declarations: k.declarations.map(({ property, value }) => ({ property, value: value * scale })) }));
	}
	return unparsed;
}
const evaluated = evaluate([{ values: ['from'], declarations: [{ property: 'scale', value: 2 }] }], 3);
console.log(evaluated[0].values.join(), names(evaluated[0].declarations), JSON.stringify(evaluated));
const rules: Declaration[] = [
	{ type: 'declaration', property: 'animation-name', value: 'spin' },
	{ type: 'comment', property: 'color', value: 'red' },
	{ type: 'declaration', property: 'animation-delay', value: '2' },
];
const declarations = rules.filter((r) => r.type === 'declaration').map(({ property, value }) => ({ property, value: value.toUpperCase() }));
console.log(names(declarations), declarations.length, JSON.stringify(declarations[1]));
