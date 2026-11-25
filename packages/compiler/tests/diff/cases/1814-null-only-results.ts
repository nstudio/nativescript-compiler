// A function that gives null where it gives nothing: its call's empty value is null, not undefined, awaited or not.
function find(items: string[], name: string): string | null {
	for (const x of items) if (x === name) return x;
	return null;
}
async function load(ok: boolean): Promise<number | null> {
	if (!ok) return null;
	return 42;
}
class Store {
	pick(k: string): { k: string } | null {
		return k ? { k } : null;
	}
}
async function main() {
	const a = find(['x'], 'y');
	const b = await load(false);
	const c = new Store().pick('');
	console.log(a === null, a === undefined, b === null, b === undefined, c === null, String(a), JSON.stringify({ a, b, c }));
	console.log(find(['x'], 'x'), await load(true), new Store().pick('q')?.k);
}
main();
