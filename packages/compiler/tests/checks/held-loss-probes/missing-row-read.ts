// A read through a missing row is JavaScript's TypeError, which the program can catch.
const g: string[][] = [['a']];
try {
	console.log(g[1][0]);
} catch (e) {
	console.log((e as Error).message);
}
