// @lenient-both
// Library code: a split by an untyped separator, which may be a regexp with a group that takes no part, held in a
// variable that is popped, pushed to and joined (core's style-scope.ts path resolution).
const access: any = { separator: () => '/' };
const separator = access.separator();
function resolve(importSource: string, fileName: string): string {
	const parts = importSource.split(separator);
	const names = fileName.split(separator).filter((p) => p !== '.');
	parts.pop();
	names.forEach((p) => (p === '..' ? parts.pop() : parts.push(p)));
	return parts.join(separator);
}
console.log(resolve('a/b/c.css', './d.css'), resolve('a/b/c.css', '../e/f.css'));
const byGroup: any = /(x)|-/;
const pieces = 'a-bxc'.split(byGroup);
const seen: string[] = [];
for (const s of pieces) seen.push(s === undefined ? 'unset' : s);
console.log(pieces.length, pieces[3], JSON.stringify(pieces), seen.join());
const first = pieces.slice(0, 2);
console.log(first.length, JSON.stringify(first), first.map((s) => s ?? 'unset').join());
