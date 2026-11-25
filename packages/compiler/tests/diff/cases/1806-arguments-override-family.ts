// A method reading its `arguments` and the methods overriding it, or overridden by it, which don't: each call runs the
// method of the object's class with every argument it is given.
class Logger {
	log(label: string, value?: number): string {
		return `${label}:${arguments.length}:${value ?? '-'}`;
	}
	plain(a: number, b?: number): number {
		return a + (b ?? 0);
	}
}

class Prefixed extends Logger {
	log(label: string, value?: number): string {
		return 'p/' + label + '/' + (value ?? '-');
	}
	plain(a: number, b?: number): number {
		return arguments.length * 100 + a + (b ?? 0);
	}
}

const items: Logger[] = [new Logger(), new Prefixed()];
for (const x of items) {
	console.log(x.log('a'), x.log('b', 2));
	console.log(x.plain(1), x.plain(1, 2));
}
