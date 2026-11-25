const a: any = [1, 2, 3];
a.map = () => 'custom-map';
console.log('override:', a.map());

Object.defineProperty(a, 'push', {
	get() {
		return () => 'custom-push';
	},
	configurable: true,
});
console.log('getter:', a.push());

delete a.map;
delete a.push;
console.log('restored:', a.map((x: number) => x * 10).join(','), a.push(4), a.length);

const b: any = [10, 20];
b.slice = undefined;
console.log('undef:', b.slice === undefined, 'slice' in b);
