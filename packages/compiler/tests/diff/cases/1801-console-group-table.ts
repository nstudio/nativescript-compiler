// console.group indents every console line until its groupEnd; console.table draws Node's table; dir takes a depth.
console.info('info', 1);
console.debug('debug', { a: 1 });
console.group('Group', 1);
console.log('inside\nand a second line');
console.count(null as any);
console.group();
console.table([1, 2]);
console.groupEnd();
console.groupCollapsed('collapsed');
console.dir({ deep: { er: { est: 1 } } }, { depth: 0 });
console.groupEnd();
console.groupEnd();
console.groupEnd();
console.log('outside');
console.table([
	{ a: 1, b: 'x' },
	{ a: 2, c: [1, 2, 3, 4] },
]);
console.table([1, 'two', { a: 1 }, null]);
console.table({ r1: { x: 1, y: true }, r2: { y: { p: 1, q: 2, r: 3 } } }, ['x', 'y']);
console.table([[1, 2], [3]]);
console.table(new Map<string, number>([['k', 1], ['l', 2]]));
console.table(new Set(['s', 't']));
console.table([]);
console.table('not tabular');
console.dir({ deep: { er: { est: { most: 1 } } } }, { depth: null });
console.dir([1, [2, [3, [4]]]]);
const args: unknown[] = ['spread %d', 7];
console.group(...args);
console.log('inside the spread group');
console.groupEnd();
console.assert(1 > 2, 'not on stdout');
console.log('end');
