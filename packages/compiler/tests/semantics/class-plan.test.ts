// A class's layout (src/semantics/class-plan.ts), which both class emitters spell.
//   node --test tests/semantics/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { classPlanOf, fieldsReadEarly, parameterPropertiesReadEarly } from '../../src/semantics/class-plan.ts';

/** The classes of `source` by name, with the checker of a program holding only it. */
function classes(source: string): { checker: ts.TypeChecker; cls: (name: string) => ts.ClassDeclaration } {
	const file = '/case.ts';
	const host = ts.createCompilerHost({ target: ts.ScriptTarget.ES2022, noLib: true });
	const read = host.getSourceFile;
	host.getSourceFile = (name, version, ...rest) => (name === file ? ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true) : read.call(host, name, version, ...rest));
	const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, noLib: true }, host);
	const sf = program.getSourceFile(file)!;
	return { checker: program.getTypeChecker(), cls: (name) => sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name)! };
}

const noSymbols = () => null;

test("a constructor's parameter properties and where it calls super()", () => {
	const { checker, cls } = classes(`
		class A { constructor(public a: number, b: string, readonly c: boolean) {} }
		class B extends A { constructor(private d: number) { const x = d; super(x, '', true); } }
		class C {}
	`);
	const a = classPlanOf(cls('A'), checker, noSymbols, false);
	assert.deepEqual(a.paramProps.map((p) => p.name.getText()), ['a', 'c']);
	assert.equal(a.superAt, -1);
	assert.equal(a.base, undefined);
	const b = classPlanOf(cls('B'), checker, noSymbols, false);
	assert.equal(b.base, cls('A'));
	assert.equal(b.superAt, 1);
	assert.equal(b.superCall?.getText(), "super(x, '', true)");
	const c = classPlanOf(cls('C'), checker, noSymbols, false);
	assert.equal(c.ctor, undefined);
	assert.deepEqual(c.paramProps, []);
});

test('accessors pair into one property each; one named by a symbol other than a toStringTag getter is named', () => {
	const { checker, cls } = classes(`
		class A { get x() { return 1; } set x(v: number) {} get y() { return 2; } }
		class T { get [Symbol.toStringTag]() { return 'T'; } }
		class S { set [Symbol.toStringTag](v: string) {} }
	`);
	const pairs = classPlanOf(cls('A'), checker, noSymbols, false).accessors;
	assert.deepEqual([...pairs.keys()], ['x', 'y']);
	assert.ok(pairs.get('x')!.get && pairs.get('x')!.set && !pairs.get('y')!.set);
	const tag = (n: ts.PropertyName) => (ts.isComputedPropertyName(n) ? 'jsToStringTag' : null);
	const t = classPlanOf(cls('T'), checker, tag, false);
	assert.deepEqual([...t.accessors.keys()], ['jsToStringTag']);
	assert.equal(t.symbolAccessor, undefined);
	assert.equal(classPlanOf(cls('S'), checker, tag, false).symbolAccessor?.getText(), '[Symbol.toStringTag]');
});

test("a class's own toString is its string conversion unless a base class declares one", () => {
	const { checker, cls } = classes(`
		class A { toString() { return 'a'; } }
		class B extends A { toString() { return 'b'; } }
		class C { toString(radix: number) { return ''; } }
	`);
	assert.equal(classPlanOf(cls('A'), checker, noSymbols, false).toString, true);
	assert.equal(classPlanOf(cls('B'), checker, noSymbols, false).toString, false);
	assert.equal(classPlanOf(cls('C'), checker, noSymbols, false).toString, false);
});

test("the members a class's bases give its instances, and its own valueOf and toJSON where they give none", () => {
	const { checker, cls } = classes(`
		class A { x = 1; static make(): A { return new A(); } static valueOf() { return 1; } run() {} only?(): void; }
		abstract class B extends A { abstract toJSON(): unknown; get y() { return 2; } }
		class C extends B { valueOf() { return 3; } toJSON() { return {}; } static make(): C { return new C(); } }
		class D extends C { valueOf() { return 4; } }
	`);
	const c = classPlanOf(cls('C'), checker, noSymbols, false);
	assert.deepEqual([...c.inherited].sort(), ['run', 'toJSON', 'x', 'y']);
	assert.deepEqual([...c.inheritedStatics.keys()].sort(), ['make', 'valueOf']);
	assert.equal(c.valueOf?.parent, cls('C'));
	assert.equal(c.toJSON?.parent, cls('C'));
	assert.equal(classPlanOf(cls('D'), checker, noSymbols, false).valueOf, undefined);
});

test('field initializers run before parameter properties where fields are defined, after them where assigned', () => {
	const { checker, cls } = classes(`
		class A { y = this.read(); z = 1; f = () => this.x; constructor(public x: number) {} read() { return this.x; } }
		class B { f = () => this.x; g = (() => this)(); constructor(public x: number) {} }
		class C { f = () => this.x; constructor(public x: number) {} }
		class D { y = this.x; x = 1; }
		class E { y = (() => this.x + 1)(); constructor(public x: number) {} }
		class F { a = 1; b = this.a; }
		class G { y = this.x + 1; z: number; constructor(public x: number, public k: number) { this.z = 1; } }
	`);
	const defined = classPlanOf(cls('A'), checker, noSymbols, false);
	assert.equal(defined.paramPropsFirst, false);
	assert.deepEqual(defined.initializersAfterParamProps, []);
	const assigned = classPlanOf(cls('A'), checker, noSymbols, true);
	assert.equal(assigned.paramPropsFirst, true);
	assert.deepEqual(assigned.initializersAfterParamProps.map((m) => m.name.getText()), ['y']);
	assert.deepEqual(classPlanOf(cls('B'), checker, noSymbols, true).initializersAfterParamProps.map((m) => m.name.getText()), ['g']);
	assert.deepEqual(parameterPropertiesReadEarly(cls('A'), false, checker).map((p) => p.name.getText()), ['x']);
	assert.deepEqual(parameterPropertiesReadEarly(cls('A'), true, checker), []);
	assert.deepEqual(parameterPropertiesReadEarly(cls('C'), false, checker), []);
	const names = (r: ReturnType<typeof fieldsReadEarly>) => (r === 'all' ? r : [...r].map((d) => (d as ts.NamedDeclaration).name!.getText()));
	assert.deepEqual(names(fieldsReadEarly(cls('C'), checker)), []);
	assert.deepEqual(names(fieldsReadEarly(cls('D'), checker)), ['x']);
	assert.deepEqual(names(fieldsReadEarly(cls('E'), checker)), ['x']);
	assert.deepEqual(names(fieldsReadEarly(cls('F'), checker)), []);
	assert.equal(fieldsReadEarly(cls('A'), checker), 'all');
	assert.deepEqual(names(fieldsReadEarly(cls('G'), checker)), ['x']);
	assert.deepEqual(parameterPropertiesReadEarly(cls('G'), false, checker).map((p) => p.name.getText()), ['x']);
});
