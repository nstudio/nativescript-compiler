class MyErr extends Error {}
const e = new MyErr('m');
console.log(e.message, '|', e.name, '|', String(e));
console.log(e instanceof MyErr, e instanceof Error);
console.log(Object.keys(e).join(), JSON.stringify(e));
console.log(new MyErr().message === '', 'message' in new MyErr(), Object.prototype.hasOwnProperty.call(new MyErr(), 'message'));
console.log(String(new MyErr(undefined).message));
console.log(String(new MyErr('x', { cause: 'c' }).cause), 'cause' in new MyErr('x'));
console.log(Object.prototype.hasOwnProperty.call(new MyErr('x', { cause: 'c' }), 'cause'));
class Coded extends Error {
	code = 7;
}
const c = new Coded('boom');
console.log(Object.keys(c).join(), JSON.stringify(c), c.message, c.code);
const lib = new Error('m', { cause: 'c' });
console.log('message' in lib, 'cause' in lib, 'name' in lib, 'stack' in lib, Object.prototype.hasOwnProperty.call(lib, 'message'), Object.prototype.hasOwnProperty.call(lib, 'cause'));
const bare = new Error();
console.log('message' in bare, 'cause' in bare, Object.prototype.hasOwnProperty.call(bare, 'message'), Object.prototype.hasOwnProperty.call(bare, 'name'));
const typed = new TypeError('t', { cause: 2 });
console.log('name' in typed, Object.prototype.hasOwnProperty.call(typed, 'name'), String(typed.cause), Object.keys(typed).length);
class Wrapped extends Error {
	constructor(m: string) {
		super(m, { cause: 1 });
	}
}
const w = new Wrapped('q');
console.log('message' in w, 'cause' in w, String(w.cause), Object.prototype.hasOwnProperty.call(w, 'cause'));
w.cause = undefined;
bare.message = 'set';
console.log(Object.prototype.hasOwnProperty.call(bare, 'message'), 'cause' in w);
