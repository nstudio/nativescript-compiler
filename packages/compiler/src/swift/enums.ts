// Enums as Swift.
import ts from 'typescript';
import { ident, swiftString } from './syntax.ts';
import type { Translator } from './translator.ts';
import { boxStep, unboxStep, type TypeFacts, type TypeStep } from '../semantics/type-step.ts';
import { hasModifier } from '../semantics/ast.ts';

export const enumsMethods = {
	enumDecl(this: Translator, e: ts.EnumDeclaration): string {
		const name = this.topName(e, e.name.text);
		return this.declaring(this.nestedName(e, name), 'enum', null, () => this.enumBody(e, name));
	},

	/** A declaration's Swift name as the manifest records it: inside the namespace being written, qualified by its path. */
	nestedName(this: Translator, decl: ts.Node, name: string): string {
		return ts.isModuleBlock(decl.parent) && this.declOwner ? `${this.declOwner}.${name}` : name;
	},

	enumBody(this: Translator, e: ts.EnumDeclaration, name: string): string {
		const lines = [`enum ${ident(name)} {`];
		for (const m of e.members) {
			const v = this.checker.getConstantValue(m);
			if (v === undefined) throw this.error(m, 'an enum member without a constant value');
			lines.push(`    static let ${ident(m.name.getText())}: ${typeof v === 'string' ? 'String' : 'Double'} = ${typeof v === 'string' ? swiftString(v) : String(v)}`);
			this.declare(m.name.getText(), { kind: 'var', mods: 'static ', type: typeof v === 'string' ? 'String' : 'Double', readonly: true });
		}
		// The object JavaScript makes of the enum, for its use as a value: a numeric member maps back to its name too.
		if (!hasModifier(e, ts.SyntaxKind.ConstKeyword)) {
			const entries = e.members.flatMap((m) => {
				const v = this.checker.getConstantValue(m)!;
				const key = swiftString(m.name.getText().replace(/^['"](.*)['"]$/, '$1'));
				return typeof v === 'string' ? [`(${key}, ${swiftString(v)} as Any?)`] : [`(${key}, Double(${v}) as Any?)`, `(${swiftString(String(v))}, ${key} as Any?)`];
			});
			lines.push(`    static let jsEnumObject = JSObject([${entries.join(', ')}])`);
			this.declare('jsEnumObject', { kind: 'var', mods: 'static ', type: 'JSObject', readonly: true });
		}
		lines.push('}');
		return lines.join('\n');
	},

	// ---- Functions -----------------------------------------------------------------------------

	/** The step of a value of `from` held untyped: what its box is, which the `'Any?'` paths of `convert` and `coerced` spell. */
	boxStep(this: Translator, from: string): TypeStep {
		return boxStep(from, this.library ? 'library' : this.lenient ? 'lenient' : 'checked', this.typeFacts());
	},

	/** The step of an untyped value read as `to`: which composite `fromAnyUnchecked` reads it into. */
	unboxStep(this: Translator, to: string): TypeStep {
		return unboxStep(to, this.library ? 'library' : this.lenient ? 'lenient' : 'checked', this.typeFacts());
	},

	typeFacts(this: Translator): TypeFacts {
		return { enumType: (n) => this.native.isEnumType(n), shape: (n) => this.isObjectShape(n) };
	},

	/** A native enum's or option set's value held untyped: its number, as the runtime marshals it; '' (from no code) when the type is neither. */
	untypedEnum(this: Translator, code: string, type: string): string {
		const base = type.replace(/\?$/, '');
		if (!this.native.isEnumType(base)) return code;
		if (!code) return 'enum';
		return type.endsWith('?') ? `${code}.map { Double($0.rawValue) }` : `Double(${code}.rawValue)`;
	},
};
