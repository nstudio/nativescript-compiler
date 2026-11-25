// An untyped value read into a string, number or boolean variable, binding or argument is the value itself: undefined
// stays undefined where the slot holds it.
const data: any = JSON.parse('{"name": "n", "count": 2}');
const missing: string = data.title;
const absent: number = data.total;
const off: boolean = data.flag;
console.log(missing, absent, off, missing === undefined, absent === undefined, off === undefined);
const { title, count } = data as { title: string; count: number };
console.log(title, count, title === undefined);
function show(label: string, n: number) {
	return `${label}:${n}`;
}
console.log(show(data.title, data.total));
const parts: string[] = (data.list ?? [undefined]) as string[];
console.log(parts[0], parts[0] === undefined);
