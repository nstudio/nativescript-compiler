// directory lists its entries in the file system's order (hash order on ext4): generated code ordered by either would
// differ between a Mac and a Linux CI build of the same input.

/** Strings by UTF-16 code units, as `Array.prototype.sort` with no comparator orders them. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Directory entries (`withFileTypes`) by their paths. */
export function byName(a: { name: string; parentPath?: string }, b: { name: string; parentPath?: string }): number {
	return compareText(a.parentPath ?? '', b.parentPath ?? '') || compareText(a.name, b.name);
}

/** Version strings (`1.10.2` after `1.9`), each run of digits compared as a number and anything else by code units. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.match(/\d+|\D+/g) ?? [];
	const x = parts(a);
	const y = parts(b);
	for (let k = 0; k < Math.min(x.length, y.length); k++) {
		const numeric = /^\d/.test(x[k]) && /^\d/.test(y[k]);
		const d = numeric ? Number(x[k]) - Number(y[k]) || compareText(x[k], y[k]) : compareText(x[k], y[k]);
		if (d) return d < 0 ? -1 : 1;
	}
	return x.length - y.length;
}
