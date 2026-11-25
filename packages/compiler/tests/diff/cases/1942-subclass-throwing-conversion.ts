// A value typed as a base class whose subclass overrides toString or valueOf to throw converts by what can throw.
class Shape {
	name(): string { return 'shape'; }
	toString(): string { return `[${this.name()}]`; }
}
class Broken extends Shape {
	override toString(): string { throw new TypeError('broken shape'); }
}
function show(s: Shape): string {
	return `shape: ${s}`;
}
function label(s: Shape): string {
	return 'label ' + s;
}
console.log(show(new Shape()), label(new Shape()));
try { console.log(show(new Broken())); } catch (e) { console.log('show', (e as Error).name, (e as Error).message); }
try { console.log(label(new Broken())); } catch (e) { console.log('label', (e as Error).name, (e as Error).message); }
