// Key plans as Swift: the notes an object keeps of its keys and their observers.
import ts from 'typescript';
import { swiftString, RT } from './syntax.ts';
import { ERRORS } from '../semantics/globals.ts';
import type { Translator } from './translator.ts';
import { keyOf, madeBit, madeLevelRuns, type ShapeFacts, type ShapePlan } from '../semantics/shapes.ts';
import { isWriteTarget } from '../semantics/ast.ts';

export const keyPlansMethods = {
	/** How this backend writes a class, which the key plans ask (shapes.ts). */
	shapeFacts(this: Translator): ShapeFacts {
		return (this.shapeFactSet ??= {
			defines: !this.assignFields,
			byName: (c) => !this.isComponentClass(c) && !this.patterns.mixinTarget(c) && this.framework.classRole(c, this.pluginFiles) !== 'service',
			kitBased: (c) => !ERRORS[c.heritageClauses!.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)!.types[0].expression.getText()] && !!this.kitRootOf(c),
			kitHeld: (c, m) => {
				const kitRoot = this.kitRootOf(c);
				return !!this.kitRedeclared(m) || (!!kitRoot && !!this.core.isKitView(kitRoot) && !!this.properties?.isRegistered(c, m.name.getText()));
			},
			expando: (c) => this.pluginFiles.has(c.getSourceFile().fileName) || this.givenUndeclared().has(c),
			descriptors: (c) => !this.errorBased(c),
			typeOf: (e) => this.typeOf(e),
		});
	},

	/** The test of whether a key made now must be noted, as the plans' order no longer places it. */
	keysNoted(this: Translator, plan: ShapePlan): string {
		return plan.noted === 'keys' ? 'jsKeysNoted' : 'jsOrder != nil';
	},

	madeNote(this: Translator, cls: ts.ClassLikeDeclaration, n: string): string {
		const { word, bit } = this.madeBitOf(cls, n)!;
		// The bit's test inline: a write that makes no key calls nothing.
		return `if jsMadeBits${word} & (1 << ${bit}) == 0 { ${RT.jsMadeNote}(&jsMadeBits${word}, &jsMade, 1 << ${bit}, ${swiftString(n)}) }`;
	},

	/** A flagged field's observer, which notes its key when a write makes it (Swift runs none in the class's own initializer: `initKeyNotes`). */
	keyObservers(this: Translator, cls: ts.ClassLikeDeclaration, n: string): string {
		if (this.madeField(cls, n)) return ` { didSet { ${this.madeNote(cls, n)} } }`;
		const p = this.keyPlan(cls);
		return p?.flagged.has(n) && p.ordered ? ` { didSet { if !__has_${n} { __has_${n} = true; jsKeyMade(${swiftString(n)}${this.earlyKey(p)}) } } }` : '';
	},

	/**
	 * A subclass's field made by its base's constructor (a method it overrides) goes before the keys of the subclass's own
	 * level, which its static place is after: `jsKeyMade`'s `early` argument.
	 */
	earlyKey(this: Translator, p: ShapePlan): string {
		return p.depth > 0 && p.gated ? `, early: jsLevel < ${p.depth}` : '';
	},

	/** Declares the state a keyed class's keys read in `dynamicMembers`: its flags, and in the root `jsOrder` and `jsLevel`. */
	keyedMembers(this: Translator, cls: ts.ClassLikeDeclaration, appBase: boolean, lines: string[], conformances: string[]): void {
		const made = this.madeKeys(cls);
		if (made?.declares) {
			for (let k = 0; k < made.words; k++) lines.push(`    final var jsMadeBits${k}: UInt64 = 0`);
			lines.push('    final var jsMade: [String]?');
			conformances.push('JSKeysMade');
		}
		const p = this.keyPlan(cls);
		if (!p) return;
		const { ordered, gated } = p;
		const written = (n: string) => keyOf(p, n)?.presence === 'written';
		if (ordered) {
			for (const n of p.flagged) lines.push(`    var __has_${n} = ${!written(n)}`);
			if (!appBase) {
				lines.push('    var jsOrder: [String]?');
				if (gated) lines.push('    var jsLevel = 0');
				if (p.expando) lines.push('    var jsAddedKeys: [String] { jsExpando?.jsKeys ?? [] }');
				conformances.push('JSKeyOrdered');
			}
		}
	},

	/** The notes after the statements of a constructor that write keys, which run no observer there; a write elsewhere in it is refused. */
	initKeyNotes(this: Translator, cls: ts.ClassLikeDeclaration, ctor: ts.ConstructorDeclaration): Map<ts.Statement, string> {
		const notes = new Map<ts.Statement, string>();
		if (this.library && ctor.body) {
			// Writes in a class's own initializer run no observer.
			const visit = (x: ts.Node): void => {
				if (ts.isFunctionLike(x) || ts.isClassLike(x)) return;
				if (ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.ThisKeyword && isWriteTarget(x) && this.madeField(cls, x.name.text) && cls.members.some((m) => ts.isPropertyDeclaration(m) && m.name.getText() === x.name.text)) {
					const st = ts.findAncestor(x, ts.isStatement)!;
					if (!ts.isExpressionStatement(st) && !ts.isVariableStatement(st)) throw this.error(x, "a write that makes a key, inside an expression of its class's constructor");
					notes.set(st, [...new Set([...(notes.get(st)?.split('; ') ?? []), this.madeNote(cls, x.name.text)])].join('; '));
				}
				ts.forEachChild(x, visit);
			};
			visit(ctor.body);
			return notes;
		}
		const p = this.keyPlan(cls);
		if (!p?.ordered || !ctor.body) return notes;
		// Below a base, whose constructor may have made keys out of order, a key the walk predicts goes after them all the same.
		const based = !!cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
		const made = (n: string) => `jsKeyMade(${swiftString(n)})`;
		const noted = this.keysNoted(p);
		const visit = (x: ts.Node): void => {
			if (ts.isFunctionLike(x) || ts.isClassLike(x)) return;
			const target = ts.isBinaryExpression(x) && x.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && x.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? x.left : (ts.isPrefixUnaryExpression(x) || ts.isPostfixUnaryExpression(x)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(x.operator) ? x.operand : null;
			const left = target && ts.skipOuterExpressions(target);
			if (left && ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isIdentifier(left.name)) {
				const n = left.name.text;
				const walked = p.walked.get(x);
				const st = ts.walkUpParenthesizedExpressions(x.parent);
				if (p.flagged.has(n) || (walked?.first && based)) {
					if (!ts.isExpressionStatement(st)) throw this.error(x, "a write that makes a key, inside an expression of its class's constructor");
					const note = !p.flagged.has(n) ? `if ${noted} { ${made(n)} }` : walked ? (based ? `if !__has_${n} { __has_${n} = true; if ${noted} { ${made(n)} } }` : `__has_${n} = true`) : `if !__has_${n} { __has_${n} = true; ${made(n)} }`;
					notes.set(st, note);
				}
			}
			ts.forEachChild(x, visit);
		};
		visit(ctor.body);
		return notes;
	},

	/** A subclass's start of its level of the constructor: its keys from there on (`jsLevel`), and its keys made now. */
	levelStart(this: Translator, cls: ts.ClassLikeDeclaration): string[] {
		const made = this.madeKeys(cls);
		if (made)
			return madeLevelRuns(made.level).map((run) => {
				if (run.at === undefined) return `        ${RT.jsMadeLevel}(&jsMade, [${run.names.map(swiftString).join(', ')}])`;
				const { word, bit } = madeBit(run.at);
				return `        if jsMadeBits${word} & (1 << ${bit}) == 0 { ${RT.jsMadeNote}(&jsMadeBits${word}, &jsMade, 1 << ${bit}, ${swiftString(run.names[0])}) }`;
			});
		const p = this.keyPlan(cls);
		if (!p || p.depth === 0 || !p.gated) return [];
		const now = p.keys.filter((k) => k.presence === 'always').map((k) => k.name);
		return [`        jsLevel = ${p.depth}`, ...(now.length ? [`        if ${this.keysNoted(p)} { ${now.map((n) => `jsKeyMade(${swiftString(n)})`).join('; ')} }`] : [])];
	},
};
