// Subclasses of native classes (`@NativeClass()` classes, `Base.extend({ … })`) and the protocols they implement, as Swift classes.
import ts from 'typescript';
import { DEPLOYMENT, NUMBERS, base, bridge, enteredGuard, integral, labeled, onMainThread, optional, typedCollection, unwrapAs } from './bridging.ts';
import { NONISOLATED_DEINIT, functionParts, ident, optionalType, splitTopLevel, RT } from '../syntax.ts';
import type { NativeAPI } from './api.ts';
import { conformsTo, lookupClass, lookupInit, lookupMember, nativeTable, type NativeMethod, type SwiftType } from './sdk.ts';
import { isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeSubclassesMethods = {
	/**
	 * The selector Objective-C calls for an exposed method that throws (a throwing `@objc` method's
	 * selector takes an error out-parameter): the method, what it throws reported as script reports
	 * what nothing catches.
	 */
	exposedEntry(this: NativeAPI, method: string, jsName: string): string {
		const m = /func \w+\((.*)\)(?: throws)?(?: -> (.+?))? \{/.exec(method.split('\n')[0]);
		if (!m) throw new Error(`${jsName}: no signature to expose`);
		const params = m[1]
			? splitTopLevel(m[1]).map(
					(p, k) =>
						`_ __a${k}: ${p
							.slice(p.indexOf(':') + 1)
							.replace(/=.*$/, '')
							.trim()}`,
				)
			: [];
		const call = this.t.marks.tryCode(`self.${jsName}(${params.map((_, k) => `__a${k}`).join(', ')})`);
		const ret = m[2];
		const body = ret ? `${RT.jsReportedOrZero} { ${call} }` : `${RT.jsReport} { ${call} }`;
		const types = params.map((p) => p.slice(p.indexOf(':') + 1).trim());
		const guard = enteredGuard(
			`__objc_${jsName}`,
			types.map(() => null),
			types,
			ret ?? 'Void',
			'',
		);
		this.t.declare(`__objc_${jsName}`, { kind: 'func', params: params.join(', '), type: ret ?? 'Void' });
		return `    @objc(${jsName}${':'.repeat(params.length)}) public nonisolated func __objc_${jsName}(${params.join(', ')})${ret ? ` -> ${ret}` : ''} { ${guard}; ${onMainThread(
			body,
			ret ?? 'Void',
			'',
			params.map((_, k) => `__a${k}`),
			types,
		)} }`;
	},

	exposedArity(this: NativeAPI, name: string): number {
		if (!this.exposed) {
			this.exposed = new Map();
			for (const sf of this.t.sourceFiles) {
				const visit = (n: ts.Node) => {
					if (ts.isPropertyDeclaration(n) && n.name.getText() === 'ObjCExposedMethods' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
						for (const p of n.initializer.properties) {
							const spec = ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer) ? p.initializer : null;
							const params = spec?.properties.find((x) => x.name?.getText() === 'params');
							const count = params && ts.isPropertyAssignment(params) && ts.isArrayLiteralExpression(params.initializer) ? params.initializer.elements.length : 0;
							this.exposed!.set(p.name!.getText(), count);
						}
					}
					ts.forEachChild(n, visit);
				};
				visit(sf);
			}
		}
		return this.exposed.get(name) ?? 0;
	},

	/**
	 * A TypeScript class extending an Objective-C class (`@NativeClass() class
	 * Delegate extends NSObject implements UITextFieldDelegate`): an NSObject
	 * subclass whose methods that override the base class or implement an
	 * adopted protocol take their Swift signatures from the SDK table, and whose
	 * `ObjCExposedMethods` are `@objc` for target-action selectors.
	 */
	classDecl(this: NativeAPI, cls: ts.ClassDeclaration): string | null {
		const t = this.t;
		const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		if (!heritage) return null;
		const baseSym = t.resolve(heritage.expression);
		const base = this.symbolModule(baseSym);
		if (!base) return null;
		const baseCls = lookupClass(base.module, base.name);
		if (!baseCls) throw t.error(heritage, `extending ${base.name} (no Swift class)`, 'native');
		// A namespace's class is declared inside the namespace's enum, by its own name.
		const name = ts.isModuleBlock(cls.parent) ? cls.name!.text : t.topName(cls, cls.name!.text);
		return t.declaring(t.nestedName(cls, name), 'class', this.className(baseCls), () => this.subclassCode(cls, name, base, baseCls));
	},

	subclassCode(this: NativeAPI, cls: ts.ClassDeclaration, name: string, base: { module: string; name: string }, baseCls: NonNullable<ReturnType<typeof lookupClass>>): string {
		const t = this.t;
		const protocols = this.adoptedProtocols(cls);
		const statics = cls.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !!m.initializer && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) === true);
		const listed = statics.find((m) => m.name.getText() === 'ObjCProtocols');
		const exposedSpec = statics.find((m) => m.name.getText() === 'ObjCExposedMethods');
		const exposed = new Set(exposedSpec && ts.isObjectLiteralExpression(exposedSpec.initializer!) ? exposedSpec.initializer.properties.map((p) => p.name!.getText()) : []);

		// A protocol the native base conforms to already is its conformance.
		const lines = [`@MainActor final class ${name}: ${[this.className(baseCls), ...protocols.filter((p) => !conformsTo(base.module, base.name, p.name)).map((p) => p.swift)].join(', ')} {`];
		t.indent = '    ';
		t.inNativeClassBody = true;
		for (const m of cls.members) {
			if (!ts.isPropertyDeclaration(m) || m === listed || m === exposedSpec) continue;
			const n = m.name.getText();
			const type = t.typeOf(m.name);
			const isStatic = ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
			if (isStatic) {
				lines.push(`    static var ${n}: ${type} = ${m.initializer ? t.coerce(m.initializer, type) : (t.zero(type) ?? 'nil')}`);
				t.declare(n, { kind: 'var', mods: 'static ', type });
				continue;
			}
			const nullish = t.nullishStorage(m);
			if (nullish && !m.initializer) {
				lines.push(`    var ${n}: ${nullish.type} = nil`);
				t.declare(n, { kind: 'var', type: nullish.type });
				continue;
			}
			if (!m.initializer) {
				lines.push(`    var ${n}: ${t.deferredType(type)}`);
				t.declare(n, { kind: 'var', type: t.deferredType(type) });
				continue;
			}
			const held = nullish?.type ?? type;
			t.declare(n, { kind: 'var', type: held });
			// UIKit decides which initializer runs (init(frame:), init(coder:)…): fields initialize on first use instead.
			// One that throws is reported, the field then holding its type's zero, as no constructor call is there to throw to.
			const init = nullish?.init ?? t.coerce(m.initializer, type);
			lines.push(`    ${t.pure(m.initializer) ? '' : 'lazy '}var ${n}: ${held} = ${t.tryPrefix(m.initializer) ? `${RT.jsReportedOrZero} { () throws -> ${held} in try ${init} }` : init}`);
		}
		if (cls.members.some((m) => ts.isConstructorDeclaration(m))) throw t.error(cls, `a constructor in a class extending ${base.name} (NativeScript creates these with new() or alloc().init())`, 'native');
		// Accessors of the app's own: Swift properties.
		const accessors = new Map<string, { get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }>();
		for (const m of cls.members) {
			if (!ts.isGetAccessorDeclaration(m) && !ts.isSetAccessorDeclaration(m)) continue;
			if (ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) throw t.error(m, `a static accessor in a class extending ${base.name}`, 'native');
			const a = accessors.get(m.name.getText()) ?? {};
			if (ts.isGetAccessorDeclaration(m)) a.get = m;
			else a.set = m;
			accessors.set(m.name.getText(), a);
		}
		for (const [n, a] of accessors) {
			// A property the native base declares (`preferredStatusBarStyle`): its Swift override, the body's value converted, what it throws reported.
			const { native, viaProtocol } = this.nativeProperty(base, protocols, n);
			if (native && native.kind === 'property' && a.get) {
				// Lenient code: an object the getter gives may be undefined, which an optional native property takes as nil.
				const declared = t.returnTypeOf(a.get);
				const own = optional(native.type) && t.lenientRef(declared) !== declared ? optionalType(declared) : declared;
				const body = t.functionBody(a.get, own, '            ');
				const value = t.throwsInfo.fn(a.get) ? `${RT.jsReported} { () throws -> ${own} in${body.slice(1)}${own.endsWith('?') && !isUntyped(spelledType(own)) ? ' ?? nil' : ''}` : `{ () -> ${own} in${body.slice(1)}()`;
				const fallback = own.endsWith('?') || isUntyped(spelledType(own)) || optional(native.type) ? '' : t.zero(own) ? ` ?? ${t.zero(own)}` : ` ?? ${RT.jsNativeZero}(${own.replace(/!$/, '?')}.self)`;
				const get = `        get {\n            let __value: ${t.throwsInfo.fn(a.get) ? optionalType(own) : own} = ${value}\n            return ${this.toSwiftValue(`__value${t.throwsInfo.fn(a.get) ? fallback : ''}`, own, native.type)}\n        }`;
				const parts = [get];
				if (a.set) {
					if (native.readonly) throw t.error(a.set, `a setter of ${base.name}.${n}`, 'native');
					const p = a.set.parameters[0].name as ts.Identifier;
					const pt = t.typeOf(p);
					const body = t.functionBody(a.set, 'Void', '            ');
					const bt = optional(native.type) && !optional(pt) && !['Double', 'String', 'Bool'].includes(pt) ? t.bindsOptional(p, pt) : pt;
					const bind = `            let ${p.text}: ${bt} = ${this.fromSwiftValue('newValue', native.type, bt)}`;
					parts.push(t.throwsInfo.fn(a.set) ? `        set {\n${bind}\n            ${RT.jsReport} ${body.trimStart()}\n        }` : `        set {\n${bind}${body.slice(1)}`);
				}
				lines.push(`    ${viaProtocol ? '' : 'override '}var ${native.swift}: ${native.type} {`, ...parts, '    }');
				t.declare(native.swift, { kind: 'var', mods: viaProtocol ? '' : 'override ', type: native.type });
				continue;
			}
			const type = a.get ? t.returnTypeOf(a.get) : optionalType(t.typeOf(a.set!.parameters[0].name));
			const parts = [a.get ? `        get${t.throwsInfo.fn(a.get) ? ' throws' : ''} ${t.functionBody(a.get, t.lenientRef(type), '        ')}` : '        get { nil }'];
			if (a.set) {
				const p = a.set.parameters[0].name as ts.Identifier;
				const body = t.functionBody(a.set, 'Void', '        ');
				parts.push(t.throwsInfo.fn(a.set) ? `        set {\n            let ${p.text}: ${type} = newValue\n            ${RT.jsReport} ${body.trimStart()}\n        }` : `        set {\n            let ${p.text}: ${type} = newValue${body.slice(1)}`);
			}
			lines.push(`    var ${n}: ${t.lenientRef(type)} {`, ...parts, '    }');
			t.declare(n, { kind: 'var', type: t.lenientRef(type), throws: !!a.get && t.throwsInfo.fn(a.get) });
		}
		for (const m of cls.members) {
			if (!ts.isMethodDeclaration(m) || !m.body) continue;
			const jsName = m.name.getText();
			if (ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) {
				if (jsName === 'new' || jsName === 'alloc') continue;
				lines.push('    ' + t.memberFunc(m, jsName, 'static '));
				continue;
			}
			// Swift has no `dealloc` to override: the object's deinit, which runs the base's teardown after it.
			if (jsName === 'dealloc' && !m.parameters.length) {
				// Isolated: the last release can come from another thread, and the body is script code.
				lines.push(t.throwsInfo.fn(m) ? `    isolated deinit {\n        ${RT.jsReport} ${t.functionBody(m, 'Void', '        ').trimStart()}\n    }` : `    isolated deinit ${t.functionBody(m, 'Void', '    ').trimStart()}`);
				continue;
			}
			const init = /^init/.test(jsName) ? lookupInit(base.module, base.name, jsName) : null;
			if (init) {
				lines.push(this.nativeInit(m, init));
				if (!lines.some((l) => /init\?\(coder/.test(l))) {
					lines.push('    required init?(coder: NSCoder) { super.init(coder: coder) }');
					t.declare('init', { kind: 'init', params: 'coder: NSCoder', type: `${t.nestedName(cls, name)}?` });
				}
				continue;
			}
			const fromProtocol = protocols.map((p) => lookupMember(p.module, p.name, jsName, false)).find(Boolean);
			const fromBase = lookupMember(base.module, base.name, jsName, false);
			const target = fromProtocol ?? fromBase;
			if (target && target.kind === 'method') {
				lines.push(this.nativeMethod(m, target, !!fromBase && fromBase.kind === 'method' && (!fromProtocol || fromBase.swift === fromProtocol.swift)));
				continue;
			}
			if (exposed.has(jsName) && t.throwsInfo.fn(m)) {
				lines.push('    ' + t.memberFunc(m, jsName), this.exposedEntry(t.func(m, jsName), jsName));
				continue;
			}
			lines.push('    ' + t.memberFunc(m, jsName, exposed.has(jsName) ? '@objc ' : ''));
		}
		// The class's own fields and getters, which Objective-C cannot see, read by name from untyped code (`(<any>controller).owner`).
		const native = (n: string) => !!lookupMember(base.module, base.name, n, false) || protocols.some((p) => lookupMember(p.module, p.name, n, false));
		const own = cls.members.filter((m): m is ts.PropertyDeclaration | ts.GetAccessorDeclaration => (ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m)) && ts.isIdentifier(m.name) && m !== listed && m !== exposedSpec && !ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) && !native(m.name.text) && !t.typeOf(m.name).includes('->'));
		if (own.length) {
			lines.push('    func jsMember(_ key: String) -> Any?? {', '        switch key {');
			t.declare('jsMember', { kind: 'func', params: '_ key: String', type: 'Any??' });
			if (t.declOwnerName)
				t.declarations?.names(
					t.declOwnerName,
					own.map((m) => (m.name as ts.Identifier).text),
				);
			for (const m of own) {
				const n = (m.name as ts.Identifier).text;
				lines.push(`        case ${JSON.stringify(n)}: return .some(${ts.isGetAccessorDeclaration(m) && t.throwsInfo.fn(m) ? `${RT.jsReported} { try self.${n} } ?? nil` : ts.isPropertyDeclaration(m) && t.nullishStorage(m) ? `self.${n}.jsAny` : `self.${n} as Any?`})`);
			}
			lines.push('        default: return nil', '        }', '    }');
			const writable = own.flatMap((m): { n: string; type: string; held: string | null; at: ts.PropertyDeclaration | undefined }[] => {
				const n = (m.name as ts.Identifier).text;
				if (ts.isPropertyDeclaration(m)) {
					const type = t.typeOf(m.name);
					return ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword) ? [] : [{ n, type, held: m.initializer || t.zero(type) ? type : null, at: m }];
				}
				const set = cls.members.find((s): s is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(s) && s.name.getText() === n);
				return set ? [{ n, type: t.typeOf(set.parameters[0].name), held: null, at: undefined }] : [];
			});
			if (writable.length) {
				lines.push('    func jsSetMember(_ key: String, _ newValue: Any?) -> Bool {', '        switch key {');
				t.declare('jsSetMember', { kind: 'func', params: '_ key: String, _ newValue: Any?', type: 'Bool' });
				for (const { n, type, held, at } of writable) {
					const nullish = at && t.nullishStorage(at);
					if (nullish) {
						lines.push(`        case ${JSON.stringify(n)}: ${t.storeFromAny(`self.${n}`, nullish.type, n, false, at)}; return true`);
						continue;
					}
					// Lenient code converts to the optional form, which a field held with a value from the start cannot hold: undefined leaves it.
					const lenient = held && t.lenientRef(held) !== held ? t.lenientRef(held) : null;
					const store = lenient ? `var __v: ${lenient} = self.${n}; ${t.storeFromAny('__v', type, n)}; if let __w = __v { self.${n} = __w }` : t.storeFromAny(`self.${n}`, type, n);
					lines.push(`        case ${JSON.stringify(n)}: ${store}; return true`);
				}
				lines.push('        default: return false', '        }', '    }');
			}
			lines[0] = lines[0].replace(/ \{$/, ', JSNativeMembers {');
		}
		if (!lines.some((l) => /^    isolated deinit /.test(l))) lines.splice(1, 0, NONISOLATED_DEINIT);
		t.indent = '';
		t.inNativeClassBody = false;
		lines.push('}');
		return lines.join('\n');
	},

	/**
	 * The Swift parameter names of a native method or initializer `m` implements: the script's names, so that the body
	 * reads them as they are where their types agree; `__aN` where the script declares none, or names one by a pattern
	 * or a Swift keyword.
	 */
	nativeParamNames(this: NativeAPI, m: ts.MethodDeclaration, count: number): string[] {
		return Array.from({ length: count }, (_, k) => {
			const p = m.parameters[k];
			return p && ts.isIdentifier(p.name) && !p.dotDotDotToken && ident(p.name.text) === p.name.text ? p.name.text : `__a${k}`;
		});
	},

	/** A method with the Swift signature it overrides or implements; its body sees TypeScript's types. */
	nativeMethod(this: NativeAPI, m: ts.MethodDeclaration, target: NativeMethod, override: boolean): string {
		const t = this.t;
		const tsParams = m.parameters.map((p, k) => ({ name: ts.isIdentifier(p.name) ? p.name.text : `__p${k}`, type: t.typeOf(p.name) }));
		const names = this.nativeParamNames(m, target.params.length);
		const swiftParams = target.params.map((type, k) => `${labeled(target.labels[k], names[k])}: ${target.escaping?.includes(k) ? '@escaping ' : ''}${type}`);
		const ownRet = t.returnTypeOf(m);
		// A parameter the body never reads is not bound: a non-escaping block could not be.
		const read = (k: number) => {
			const sym = this.t.checker.getSymbolAtLocation(m.parameters[k].name);
			let found = false;
			// `{ transitionContext }` reads the parameter through the shorthand's value.
			const reads = (n: ts.Identifier) => this.t.checker.getSymbolAtLocation(n) === sym || (ts.isShorthandPropertyAssignment(n.parent) && this.t.checker.getShorthandAssignmentValueSymbol(n.parent) === sym);
			const visit = (n: ts.Node): void => {
				if (!found && ts.isIdentifier(n) && reads(n)) found = true;
				else if (!found) ts.forEachChild(n, visit);
			};
			if (sym && m.body) visit(m.body);
			return found;
		};
		const binds = tsParams
			.map((p, k) => {
				const swift = target.params[k];
				if (!swift || !read(k)) return '';
				// A nullable native parameter TypeScript declares present (`launchOptions`) may be nil: the body reads it as undefined.
				if (optional(swift) && !p.type.endsWith('?') && !['Double', 'String', 'Bool'].includes(p.type) && !bridge('', swift, p.type)) {
					const type = t.bindsOptional(m.parameters[k].name, p.type);
					return `        let ${p.name}: ${type} = ${this.fromSwiftValue(names[k], swift, type)}`;
				}
				// A struct whose fields the body assigns (`size.width = 0`) is a variable of its own.
				const mutable = this.isStructType(p.type) && ts.isIdentifier(m.parameters[k].name) && this.t.needsVar(m.parameters[k].name, p.type);
				const value = this.fromSwiftValue(names[k], swift, p.type);
				// Lenient code's subclass of the native parameter's class: nil where the argument is not one.
				const held = this.t.marks.rootImplicit(value) ? t.bindsOptional(m.parameters[k].name, p.type) : p.type;
				return !mutable && value === p.name && p.type === swift ? '' : `        ${mutable ? 'var' : 'let'} ${p.name}: ${held} = ${value}`;
			})
			.filter(Boolean);
		const ret = target.returns;
		// A result Objective-C declares nullable: the body may give undefined.
		const tsRet = optional(ret) && ownRet !== 'Void' && !ownRet.endsWith('?') && !isUntyped(spelledType(ownRet)) ? optionalType(ownRet) : ownRet;
		const introduced = target.introduced && parseFloat(target.introduced) > DEPLOYMENT ? parseFloat(target.introduced) : 0;
		const body = t.availableFrom(introduced, () => t.functionBody(m, tsRet, '        '));
		const throws = t.throwsInfo.fn(m);
		const call = `{ () ${throws ? 'throws ' : ''}-> ${tsRet} in${body.slice(1)}()`;
		// A Void method's body is the method's own (its returns return from it); a value goes through a closure to be converted.
		// A value the TypeScript method returns where Objective-C returns nothing is dropped.
		const result = ret === 'Void' ? (tsRet !== 'Void' ? `        ${throws ? `${RT.jsReport} { _ = try ` : '_ = '}${call}${throws ? ' }' : ''}` : throws ? `        ${RT.jsReport} { try ${call} }` : body.slice(2, -2).replace(/^ {8}/, '        ')) : `        let __result: ${tsRet} = ${throws ? `${RT.jsReportedOrZero} { () throws -> ${tsRet} in${body.slice(1)}` : call}\n        return ${this.toSwiftValue('__result', tsRet, ret)}`;
		const available = introduced ? `@available(iOS ${target.introduced}, *) ` : '';
		const guard = enteredGuard(target.swift, target.labels, target.params, ret, '        ', target.escaping, names);
		const isolated = onMainThread(
			[...binds, result].join('\n'),
			ret,
			'        ',
			names,
			target.params.map((p, k) => (target.escaping?.includes(k) ? `@escaping ${p}` : p)),
		);
		t.declare(target.swift, { kind: 'func', mods: `${available}${override ? 'override ' : ''}`, params: swiftParams.join(', '), type: ret });
		return [`    ${available}nonisolated ${override ? 'override ' : ''}func ${target.swift}(${swiftParams.join(', ')})${ret === 'Void' ? '' : ` -> ${ret}`} {`, guard, isolated, '    }'].join('\n');
	},

	/**
	 * An override of a native initializer (`initWithStyleReuseIdentifier`), written as NativeScript has it:
	 * `const cell = super.initWith…(…)`, statements on the cell, `return cell`. In Swift the initializer
	 * itself, the cell being `self`.
	 */
	nativeInit(this: NativeAPI, m: ts.MethodDeclaration, init: NativeMethod): string {
		const t = this.t;
		const stmts = [...(m.body?.statements ?? [])];
		const first = stmts[0],
			last = stmts.at(-1);
		const decl = first && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1 ? first.declarationList.declarations[0] : undefined;
		let value = decl?.initializer;
		while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value))) value = value.expression;
		const superCall = value && ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.expression.kind === ts.SyntaxKind.SuperKeyword && value.expression.name.text === m.name.getText() ? value : undefined;
		const sym = decl && ts.isIdentifier(decl.name) ? t.checker.getSymbolAtLocation(decl.name) : undefined;
		if (!superCall || !sym || !last || !ts.isReturnStatement(last) || !last.expression || !ts.isIdentifier(last.expression) || t.checker.getSymbolAtLocation(last.expression) !== sym) {
			throw t.error(m, `an initializer override not of the form \`const x = super.${m.name.getText()}(…); …; return x\``, 'native');
		}
		// One the body reads as another type keeps `__aN`: super is passed the native value.
		const names = this.nativeParamNames(m, init.params.length).map((n, k) => (m.parameters[k] && t.typeOf(m.parameters[k].name) !== init.params[k] ? `__a${k}` : n));
		const swiftParams = init.params.map((type, k) => `${labeled(init.labels[k], names[k])}: ${init.escaping?.includes(k) ? '@escaping ' : ''}${type}`);
		const middle = stmts.slice(1, -1);
		// Parameters the body reads, bound as TypeScript types them; ones passed straight on to super, as Swift has them.
		const readIn = (sym: ts.Symbol | undefined, nodes: ts.Node[]) => {
			let found = false;
			const visit = (n: ts.Node): void => {
				if (!found && ts.isIdentifier(n) && t.checker.getSymbolAtLocation(n) === sym) found = true;
				else if (!found) ts.forEachChild(n, visit);
			};
			nodes.forEach(visit);
			return found;
		};
		const params = m.parameters.map((p) => (ts.isIdentifier(p.name) ? t.checker.getSymbolAtLocation(p.name) : undefined));
		const binds = m.parameters
			.map((p, k) => {
				if (!ts.isIdentifier(p.name) || !init.params[k] || !readIn(params[k], middle)) return '';
				const type = t.typeOf(p.name),
					value = this.fromSwiftValue(names[k], init.params[k], type);
				const held = this.t.marks.rootImplicit(value) ? t.bindsOptional(p.name, type) : type;
				return value === p.name.text && type === init.params[k] ? '' : `        let ${p.name.text}: ${held} = ${value}`;
			})
			.filter(Boolean);
		const passed = superCall.arguments.map((a, k) => {
			const at = ts.isIdentifier(a) ? params.indexOf(t.checker.getSymbolAtLocation(a)) : -1;
			return at >= 0 && init.params[k] === init.params[at] ? names[at] : this.toSwift(a, init.params[k]);
		});
		const refs: ts.Node[] = [];
		const visit = (n: ts.Node) => {
			if (ts.isIdentifier(n) && t.checker.getSymbolAtLocation(n) === sym) refs.push(n);
			ts.forEachChild(n, visit);
		};
		middle.forEach(visit);
		for (const r of refs) t.subst.set(r, 'self');
		t.indent = '        ';
		let body: string[];
		try {
			body = t.statements(middle);
		} finally {
			for (const r of refs) t.subst.delete(r);
			t.indent = '    ';
		}
		const throws = middle.some((x) => t.throwsInfo.expr(x));
		if (t.declOwnerName) t.declare('init', { kind: 'init', params: swiftParams.join(', '), type: `${t.declOwnerName}${init.failable ? '?' : ''}` });
		return [`    override init${init.failable ? '?' : ''}(${swiftParams.join(', ')}) {`, ...binds, `        super.init(${passed.map((a, k) => (init.labels[k] ? `${init.labels[k]}: ${a}` : a)).join(', ')})`, ...(throws ? [`        ${RT.jsReport} {`, ...body.map((l) => '    ' + l), '        }'] : body), '    }'].join('\n');
	},

	/** A Swift parameter value as the TypeScript body reads it. */
	fromSwiftValue(this: NativeAPI, code: string, swiftType: SwiftType, tsType: string): string {
		const b = base(swiftType);
		// A block given to script untyped (`decisionHandler: any`): a script function, its arguments converted to the block's types.
		if (isUntyped(spelledType(tsType)) && /->/.test(swiftType)) {
			const fn = swiftType.replace(/@\w+\s+/g, '').trim();
			const isOptional = /\)[?!]$/.test(fn) && fn.startsWith('((');
			const plain = isOptional ? fn.replace(/^\((.*)\)[?!]$/, '$1') : fn;
			return isOptional ? `${code}.map { ${this.t.boxFunction('$0', plain)} }` : this.t.boxFunction(code, plain);
		}
		if (NUMBERS.has(b) && tsType === 'Double') return b === 'Double' ? (optional(swiftType) ? `(${code} ?? .nan)` : code) : optional(swiftType) ? `(${code}.map { Double($0) } ?? .nan)` : `Double(${code})`;
		// A block whose parameters Swift bridges (`URLRequest?`) where TypeScript declares the Foundation class (`NSURLRequest`).
		const block = functionParts(swiftType.replace(/@\w+\s+/g, '').trim()),
			fn = functionParts(tsType);
		if (block && fn && block.params.some((p, k) => p !== fn.params[k])) return this.t.convert(code, block.text, tsType);
		// A parameter TypeScript declares as the app's own subclass (`navigationController: UINavigationControllerImpl`).
		const own = tsType.replace(/[?!]$/, '');
		const bridged = bridge(code, swiftType, tsType);
		if (bridged) return bridged;
		if (own !== b && /^(\w+\.)?[A-Z]\w*$/.test(own) && /^[A-Z]\w*$/.test(b) && !this.isEnumType(b) && !this.isStructType(b) && this.t.lenientRef(own) !== own) return this.t.marks.castCode(code, own, 'as?', true);
		if (b === 'Date' && base(tsType) === 'JSDate') return optional(swiftType) ? unwrapAs(this.t.marks, `${code}.map { JSDate($0) }`, tsType, this.t.lenient && this.t.lenientRef(tsType) !== tsType) : `JSDate(${code})`;
		// A native enum is a number in JavaScript.
		if (tsType === 'Double' && this.isEnumType(b)) return optional(swiftType) ? `Double(${code}!.rawValue)` : `Double(${code}.rawValue)`;
		if (optional(swiftType) && !tsType.endsWith('?') && !isUntyped(spelledType(tsType))) return this.absentAs(code, tsType);
		return code;
	},

	/** A TypeScript result as the Swift method returns it. */
	toSwiftValue(this: NativeAPI, code: string, tsType: string, swiftType: SwiftType): string {
		const b = base(swiftType);
		// An untyped result marshals as the runtime converts a JavaScript value: a BOOL by truthiness, a number by ToNumber.
		if (isUntyped(spelledType(tsType)) && !isUntyped(spelledType(swiftType)) && swiftType !== 'Any') {
			if (b === 'Bool' || b === 'ObjCBool') return `${RT.jsTruthy}(${code})`;
			if (NUMBERS.has(b)) return b === 'Double' ? `${RT.jsToNumber}(${code})` : integral(`${RT.jsToNumber}(${code})`, b);
			// A BOOL the runtime marshals from any value: its truthiness.
			if (b === 'Bool' && !optional(swiftType)) return `${RT.jsTruthy}(${code})`;
			return optional(swiftType) ? `(${RT.jsToNative}(${code}) as? ${b})` : `${RT.jsNativeArgument}(${code}, ${b.startsWith('any ') ? `(${b})` : b}.self)`;
		}
		if (NUMBERS.has(b) && tsType === 'Double' && b !== 'Double') return integral(code, b);
		const bridged = bridge(code, tsType, swiftType);
		if (bridged) return bridged;
		if (b === 'Date' && base(tsType) === 'JSDate') return tsType.endsWith('?') ? `${code}.map { ${RT.jsNativeDate}($0) }` : `${RT.jsNativeDate}(${code})`;
		// A Foundation array of objects where Swift has its element type (`NSArray<UIViewController>` as `[UIViewController]`).
		const elements = /^\[([\w.]+)\]$/.exec(b)?.[1];
		if (/^\[Any\][?!]?$/.test(tsType) && elements && elements !== 'Any') return optional(swiftType) ? `(${code} as? [${elements}])` : typedCollection(code, `[${elements}]`)!;
		if (tsType === 'Double' && this.isEnumType(b)) return this.enumFromNumber(code, b);
		return code;
	},

	/** A native struct by its Swift name (`CGRect`, `CATransform3D`): a value Swift compares by value. */
	isStructType(this: NativeAPI, swift: string): boolean {
		if (!this.modules.size || !/^(__)?[A-Z][\w.]*$/.test(swift) || /^(Double|String|Bool|Void|Never|Signal|Emitter|EventData|Router)$|^JS/.test(swift)) return false;
		for (const m of this.searchModules()) if (Object.values(nativeTable(m).structs).some((x) => x.swift === swift)) return true;
		return false;
	},

	/** The modules the program's native declarations come from, and those their types live in (`UIRectEdge` is UIUtilities'). */
	searchModules(this: NativeAPI): string[] {
		return [...new Set([...this.modules, ...(this.modules.has('UIKit') ? ['UIUtilities'] : [])])];
	},

	/** A JavaScript number where Swift has a native enum or option set: the value of that raw value. */
	enumFromNumber(this: NativeAPI, code: string, swiftType: string): string {
		const b = swiftType.replace(/[?!]$/, '');
		return this.isOptionSet(b) ? `${b}(rawValue: ${integral(code, this.rawTypeOf(b))})` : `${RT.jsNativeEnum}(${b}.self, ${integral(code, this.rawTypeOf(b))})`;
	},

	/** A type of named constants of any raw type (`CFRunLoopMode`, `NSNotification.Name`). */
	isTypedConstants(this: NativeAPI, swift: string): boolean {
		return this.typedConstantsRaw(swift) !== null;
	},

	/** The raw type of a type of named constants (`UIAccessibilityTraits` holds a UInt64), or null. */
	typedConstantsRaw(this: NativeAPI, swift: string): string | null {
		if (!this.modules.size || !/^(__)?[A-Z][\w.]*$/.test(swift)) return null;
		for (const m of this.searchModules()) {
			const e = Object.values(nativeTable(m).enums).find((x) => x.swift === swift && x.kind === 'typedConstants');
			if (e) return e.raw;
		}
		return null;
	},

	/** A type of named numbers (`UIAccessibilityTraits`), which script reads as numbers. */
	isNumericConstants(this: NativeAPI, swift: string): boolean {
		const raw = this.typedConstantsRaw(swift);
		return !!raw && NUMBERS.has(raw);
	},

	/** A string-valued type of named constants (`UIMenu.Identifier`, `NSAttributedString.Key`). */
	isStringConstants(this: NativeAPI, swift: string): boolean {
		return this.constantsRaw(swift) === 'String';
	},

	/** The raw type of a typed-constants struct (`UIFont.Weight` holds a CGFloat), or null. */
	constantsRaw(this: NativeAPI, swift: string): string | null {
		if (!this.modules.size || !/^(__)?[A-Z][\w.]*$/.test(swift)) return null;
		for (const m of this.searchModules()) for (const x of Object.values(nativeTable(m).enums)) if (x.swift === swift && x.kind === 'typedConstants' && x.raw) return x.raw;
		return null;
	},

	isEnumType(this: NativeAPI, swift: string): boolean {
		return !!this.enumInfo(swift);
	},

	isOptionSetType(this: NativeAPI, swift: string): boolean {
		return this.isOptionSet(swift);
	},

	isOptionSet(this: NativeAPI, swift: string): boolean {
		return this.enumInfo(swift)?.options ?? false;
	},

	rawTypeOf(this: NativeAPI, swift: string): string {
		return this.enumInfo(swift)?.raw ?? 'Int';
	},

	/** A native enum or option set by its Swift name, from the modules the program uses. */
	enumInfo(this: NativeAPI, swift: string): { raw: string; options: boolean } | null {
		if (!this.modules.size || !/^(__)?[A-Z][\w.]*$/.test(swift) || /^(Double|String|Bool|Void|Never|Signal|Emitter|EventData|Router)$|^JS/.test(swift)) return null;
		if (!this.enumTypes.has(swift)) {
			let found: { raw: string; options: boolean } | null = null;
			for (const m of this.searchModules()) {
				const e = Object.values(nativeTable(m).enums).find((x) => x.swift === swift && x.kind !== 'typedConstants');
				if (e) {
					found = { raw: e.raw, options: e.kind === 'options' };
					break;
				}
			}
			this.enumTypes.set(swift, found);
		}
		return this.enumTypes.get(swift) ?? null;
	},
};
