// Key plans as Kotlin: the notes an object keeps of its keys and the setters that keep them.
import ts from 'typescript';
import { ERRORS } from '../semantics/globals.ts';
import { kotlinString, RT } from './syntax.ts';
import type { Translator } from './translator.ts';
import { keyOf, madeBit, madeLevelRuns, type ShapeFacts, type ShapePlan } from '../semantics/shapes.ts';
import { programBase } from '../semantics/classes.ts';

export const keyPlansMethods = {
	/** How this backend writes a class, which the key plans ask (shapes.ts). */
	shapeFacts(this: Translator): ShapeFacts {
		return (this.shapeFactSet ??= {
			defines: !this.assignFields,
			byName: (c) => !this.framework.componentClass(c) && !this.components.has(c.name!.text) && !this.patterns.mixinTarget(c) && !(!this.library && !!this.collectionAlias(c)) && this.framework.classRole(c, this.pluginFiles) !== 'service',
			kitBased: (c) => !ERRORS[c.heritageClauses!.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)!.types[0].expression.getText()] && !!this.kitRootOf(c),
			kitHeld: (c, m) => {
				const kitRoot = this.kitRootOf(c);
				return !!this.kitRedeclared(m) || (!!kitRoot && !!this.core?.isKitView(kitRoot) && !!this.properties?.isRegistered(c, m.name.getText()));
			},
			expando: (c) => this.keepsAdded(c),
			descriptors: (c) => {
				let root = c;
				for (let b = programBase(c, this.checker); b; b = programBase(b, this.checker)) root = b;
				const h = root.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
				return !(h && ERRORS[h.expression.getText()]);
			},
			typeOf: (e) => this.typeOf(e),
		});
	},

	/** The test of whether a key made now must be noted, as the plans' order no longer places it. */
	keysNoted(this: Translator, plan: ShapePlan): string {
		return plan.noted === 'keys' ? 'jsKeysNoted' : 'jsOrder != null';
	},

	/** A flagged field's setter, which notes its key when a write makes it. */
	keySetter(this: Translator, cls: ts.ClassLikeDeclaration, n: string): string[] {
		const made = this.madeBitOf(cls, n);
		// The root's `jsMadeNote<word>` sets the field's bit, and at its first write notes its key.
		if (made) return [`        set(value) { field = value; jsMadeNote${made.word}(1L shl ${made.bit}, ${kotlinString(n)}) }`];
		const p = this.keyPlan(cls);
		if (!p?.flagged.has(n) || !p.ordered) return [];
		// A subclass's field made by its base's constructor (a method it overrides) goes before the keys of the subclass's own
		// level, which its static place is after.
		const early = p.depth > 0 && p.gated ? `, early = jsLevel < ${p.depth}` : '';
		return [`        set(value) { field = value; if (!__has_${n}) { __has_${n} = true; jsKeyMade(${kotlinString(n)}${early}) } }`];
	},

	/** Declares the state a keyed class's keys read in `dynamicMembers`: its flags, and in the root `jsOrder` and `jsLevel`. */
	keyedMembers(this: Translator, cls: ts.ClassLikeDeclaration, appBase: boolean, lines: string[], supertypes: string[]): void {
		const made = this.madeKeys(cls);
		if (made?.declares) {
			for (let k = 0; k < made.words; k++) lines.push(`    var jsMadeBits${k}: Long = 0L`, `    fun jsMadeNote${k}(bit: Long, key: String) { if ((jsMadeBits${k} and bit) == 0L) { jsMadeBits${k} = jsMadeBits${k} or bit; ${RT.jsMadeNote}(this, key) } }`);
			lines.push('    override var jsMade: MutableList<String>? = null');
			supertypes.push('JSKeysMade');
		}
		const p = this.keyPlan(cls);
		if (!p) return;
		const { ordered, gated } = p;
		const written = (n: string) => keyOf(p, n)?.presence === 'written';
		if (ordered) {
			for (const n of p.flagged) lines.push(`    var __has_${n} = ${!written(n)}`);
			if (!appBase) {
				lines.push('    override var jsOrder: List<String>? = null');
				if (gated) lines.push('    var jsLevel = 0');
				if (p.expando) lines.push('    override val jsAddedKeys: List<String> get() = jsExpando?.jsKeys ?: listOf()');
				supertypes.push('JSKeyOrdered');
			}
		}
	},

	/**
	 * The statements of a constructor whose writes the walk predicts (`classKeyPlan`): a flagged field's flag is set before,
	 * so its setter notes nothing, and below a base, whose constructor may have made keys out of order, the key goes last
	 * after. Every other write makes its key through the setter.
	 */
	initKeyNotes(this: Translator, cls: ts.ClassLikeDeclaration): Map<ts.Statement, { before: string; after: string }> {
		const notes = new Map<ts.Statement, { before: string; after: string }>();
		const p = this.keyPlan(cls);
		if (!p?.ordered) return notes;
		const based = !!cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
		for (const [x, w] of p.walked) {
			const flagged = p.flagged.has(w.field);
			if (!flagged && !(w.first && based)) continue;
			const made = `__made${this.tmp++}`;
			const before = !flagged ? '' : based ? `val ${made} = !__has_${w.field}; __has_${w.field} = true` : `__has_${w.field} = true`;
			const after = based ? `if (${flagged ? `${made} && ` : ''}${this.keysNoted(p)}) jsKeyMade(${kotlinString(w.field)})` : '';
			notes.set(x.parent as ts.Statement, { before, after });
		}
		return notes;
	},

	/**
	 * A library subclass's keys made as its level of the constructor starts (`MadeKeys.level`): an `init` before its fields,
	 * whose initializers run before the constructor's body and may write a base's made field.
	 */
	madeLevelInit(this: Translator, cls: ts.ClassLikeDeclaration): string[] {
		const made = this.madeKeys(cls);
		if (!made?.level.length) return [];
		const notes = madeLevelRuns(made.level).map((run) => (run.at === undefined ? `        if (jsMade != null) ${RT.jsMadeLevel}(this, listOf(${run.names.map(kotlinString).join(', ')}))` : `        jsMadeNote${madeBit(run.at).word}(1L shl ${madeBit(run.at).bit}, ${kotlinString(run.names[0])})`));
		return ['    init {', ...notes, '    }'];
	},

	/** A subclass's start of its level of the constructor: its keys from there on (`jsLevel`), and its keys made now. */
	levelStart(this: Translator, cls: ts.ClassLikeDeclaration): string[] {
		if (this.madeKeys(cls)) return [];
		const p = this.keyPlan(cls);
		if (!p || p.depth === 0 || !p.gated) return [];
		const now = p.keys.filter((k) => k.presence === 'always').map((k) => k.name);
		return [`        jsLevel = ${p.depth}`, ...(now.length ? [`        if (${this.keysNoted(p)}) { ${now.map((n) => `jsKeyMade(${kotlinString(n)})`).join('; ')} }`] : [])];
	},
};
