// URL resolution and invalid URL TypeError on both Swift and Kotlin.
const base = new URL('https://example.com/app/main.js');
console.log(base.href);
console.log(new URL('./worker.js', base.href).href);
try {
	new URL('not a url');
	console.log('unexpected');
} catch (e) {
	console.log((e as Error).name);
}
