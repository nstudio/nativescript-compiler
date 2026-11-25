// SDK availability as Swift: `if #available` tests and the code that runs only where the OS has an API.
import ts from 'typescript';
import { exitsStatement, unnestAvailability, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { DEPLOYMENT } from './native/bridging.ts';
import { packageOf } from '../program/core-facts.ts';

export const availabilityMethods = {
	/** Core's `SDK_VERSION` (`utils/constants`): the running iOS version, as `parseFloat` reads it. */
	isSdkVersion(this: Translator, e: ts.Expression): boolean {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
		let sym = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
		const file = sym?.name === 'SDK_VERSION' ? sym.declarations?.[0]?.getSourceFile().fileName : undefined;
		return !!file && /[\\/]utils[\\/]constants(\.ios)?(\.d)?\.ts$/.test(file) && packageOf(file)?.name === '@nativescript/core';
	},

	/**
	 * `SDK_VERSION >= N` (present) or `SDK_VERSION < N` (absent) for an N newer than the deployment target: the same test as
	 * `#available(iOS N, *)`, since `parseFloat` of the system version is at least N exactly when the OS is.
	 */
	sdkVersionTest(this: Translator, e: ts.BinaryExpression): { version: number; present: boolean } | null {
		const K = ts.SyntaxKind;
		const mirrored: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = { [K.LessThanEqualsToken]: K.GreaterThanEqualsToken, [K.GreaterThanToken]: K.LessThanToken };
		const [n, op] = this.isSdkVersion(e.left) ? [e.right, e.operatorToken.kind] : this.isSdkVersion(e.right) ? [e.left, mirrored[e.operatorToken.kind]] : [null, undefined];
		if (!n || !ts.isNumericLiteral(n) || (op !== K.GreaterThanEqualsToken && op !== K.LessThanToken)) return null;
		const version = parseFloat(n.text);
		return version > DEPLOYMENT ? { version, present: op === K.GreaterThanEqualsToken } : null;
	},

	/** `typeof NewClass !== 'undefined'` of a class newer than the deployment target, or a test of `SDK_VERSION`: the iOS version, and whether the test is for its presence. */
	availabilityTest(this: Translator, e: ts.Expression): { version: number; present: boolean } | null {
		while (ts.isParenthesizedExpression(e)) e = e.expression;
		if (!ts.isBinaryExpression(e)) return null;
		const sdk = this.sdkVersionTest(e);
		if (sdk) return sdk;
		const op = e.operatorToken.kind;
		const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
		if (!eq && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return null;
		// `x.newProperty !== undefined`, core's test for a property the OS may not have: as `#available` of its version.
		const isUndefined = (x: ts.Expression) => ts.isIdentifier(x) && x.text === 'undefined';
		const tested = isUndefined(e.right) ? e.left : isUndefined(e.left) ? e.right : null;
		const property = tested && this.native.propertyIntroducedAfterDeployment(tested);
		if (property) return { version: property, present: !eq };
		const [t, lit] = ts.isTypeOfExpression(e.left) ? [e.left, e.right] : ts.isTypeOfExpression(e.right) ? [e.right, e.left] : [null, null];
		if (!t || !lit || !ts.isStringLiteral(lit) || lit.text !== 'undefined') return null;
		const version = this.native.introducedAfterDeployment(t.expression);
		return version ? { version, present: !eq } : null;
	},

	/**
	 * An `if` testing for a class newer than the deployment target, as Swift checks availability:
	 * `if (typeof X !== 'undefined' && …)` is `if #available(…), …`, and `if (… || typeof X === 'undefined') return;`
	 * is that test and then `guard #available(…)`; the code they guard may use the class.
	 */
	availabilityIf(this: Translator, s: ts.IfStatement): string | null {
		const i = this.indent;
		const terms = (e: ts.Expression, op: ts.SyntaxKind): ts.Expression[] => {
			while (ts.isParenthesizedExpression(e)) e = e.expression;
			return ts.isBinaryExpression(e) && e.operatorToken.kind === op ? [...terms(e.left, op), ...terms(e.right, op)] : [e];
		};
		const join = (xs: ts.Expression[], op: string) => xs.map((x) => `(${this.tryPrefix(x)}${this.cond(x)})`).join(` ${op} `);
		const all = terms(s.expression, ts.SyntaxKind.AmpersandAmpersandToken);
		const present = all.map((x) => this.availabilityTest(x)).find((t) => t?.present);
		if (present) {
			const rest = all.filter((x) => !this.availabilityTest(x)?.present);
			const saved = this.refinedVersion;
			this.refinedVersion = Math.max(saved, present.version);
			const conditions = rest.length ? `, ${join(rest, '&&')}` : '';
			const then = this.block(s.thenStatement);
			this.refinedVersion = saved;
			return `${i}if #available(iOS ${present.version}, *)${conditions} ${then}${s.elseStatement ? ` else ${this.block(s.elseStatement)}` : ''}`;
		}
		const any = terms(s.expression, ts.SyntaxKind.BarBarToken);
		const absent = any.map((x) => this.availabilityTest(x)).find((t) => t && !t.present);
		if (absent && any.length === 1 && s.elseStatement) {
			const saved = this.refinedVersion;
			this.refinedVersion = Math.max(saved, absent.version);
			const otherwise = this.block(s.elseStatement);
			this.refinedVersion = saved;
			return `${i}if #available(iOS ${absent.version}, *) ${otherwise} else ${this.block(s.thenStatement)}`;
		}
		if (!absent || s.elseStatement || !exitsStatement(s.thenStatement)) return null;
		const rest = any.filter((x) => {
			const t = this.availabilityTest(x);
			return !(t && !t.present);
		});
		const exit = this.block(s.thenStatement);
		this.refinedVersion = Math.max(this.refinedVersion, absent.version);
		return `${rest.length ? `${i}if ${join(rest, '||')} ${exit}\n` : ''}${i}guard #available(iOS ${absent.version}, *) else ${exit}`;
	},

	/** A type newer than the deployment target named inside a function body: the body runs only where the OS has it. Outside a body, nothing. */
	requireTypeAvailability(this: Translator, version: number, name?: string) {
		if (name) this.gatedTypes.set(name, Math.max(this.gatedTypes.get(name) ?? 0, version));
		if (!this.availability.length || version <= this.refinedVersion) return;
		const named = name && this.statementTypes.get(this.availability.length);
		if (named) named.set(name, Math.max(named.get(name) ?? 0, version));
		else this.requireAvailability(version);
	},

	requireAvailability(this: Translator, version: number) {
		if (version <= this.refinedVersion) return;
		if (this.availability.length) this.availability[this.availability.length - 1] = Math.max(this.availability[this.availability.length - 1], version);
		else this.moduleAvailability = Math.max(this.moduleAvailability, version);
	},

	/**
	 * Statements that use APIs newer than the deployment target, run only on an OS that has them (the app's own checks decide when).
	 * On an older one, `otherwise`: what script meets there, the TypeError of reading a member of the missing class.
	 */
	availableOnly(this: Translator, version: number, lines: string, base: string, otherwise: string): string {
		return `${base}if #available(iOS ${version}, *) {\n${unnestAvailability(lines, version)
			.split('\n')
			.map((l) => '    ' + l)
			.join('\n')}\n${base}} else {\n${base}    ${otherwise}\n${base}}`;
	},

	/** Whether the code being translated already runs only on iOS `version` or newer (inside `if #available`). */
	availabilityChecked(this: Translator, version: number): boolean {
		return version <= this.refinedVersion;
	},

	/** Leaving a function on an OS without an API it uses: the TypeError thrown where it throws, else reported and undefined given. */
	unavailable(this: Translator, version: number, ret: string, throws: boolean): string {
		const error = `${RT.jsUnavailable}(${version})`;
		if (throws) return `throw JSException(${error})`;
		if (/^JSPromise<.*>$/.test(ret)) return `return ${ret}.reject(${error}.value)`;
		const report = `${RT.jsReportUncaught}(${error}.value); `;
		if (ret === 'Void' || ret === 'Never') return `${report}return`;
		return report + this.undefinedReturn(ret, false);
	},
};
