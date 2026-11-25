// The program's classes whose members are read and called by name: those an untyped downcast may hold.
import ts from 'typescript';
import type { ValueStates } from './value-states.ts';
import { heldDowncasts } from '../nullish.ts';

export const byNameMethods = {
	heldCasts(this: ValueStates): ReturnType<typeof heldDowncasts> {
		const b = this.backend;
		return (this.downcastSet ??= heldDowncasts(b.checker, b.sourceFiles, (f) => b.pluginFiles.has(f.fileName), this.nullish().held));
	},

	/** A class a held downcast's value may be an object of: its members are read and its methods called by name. */
	downcastClass(this: ValueStates, cls: ts.ClassLikeDeclaration): boolean {
		return !this.backend.library && !this.backend.lenient && this.heldCasts().classes.has(cls);
	},

	/** An app class script reaches by name (`Forms.byNameClasses`): its methods and accessors are readable, callable and settable by name. */
	byNameClass(this: ValueStates, cls: ts.ClassLikeDeclaration): boolean {
		return !this.backend.library && !this.packaged(cls) && this.forms().byNameClasses().has(cls);
	},

	/**
	 * Whether script may read an app class's member by name, given that the class's members are read by name at all: under
	 * `xmlMemberKeys`, a class only XML code and `bindingContext`s hold untyped (`Forms.keyedByNameClasses`), or none,
	 * answers only to the listed keys.
	 */
	byNameMember(this: ValueStates, cls: ts.ClassLikeDeclaration, name: string): boolean {
		const k = this.backend.xmlMemberKeys;
		if (!k || this.backend.library || this.packaged(cls) || this.downcastClass(cls)) return true;
		const f = this.forms();
		if (f.byNameClasses().has(cls) && !f.keyedByNameClasses().has(cls)) return true;
		return k.keys.has(name);
	},

	/** An app class whose objects an object type reads by name (`Forms.viewedClasses`): its methods and accessors are readable by name. */
	viewedClass(this: ValueStates, cls: ts.ClassLikeDeclaration): boolean {
		return !this.backend.library && this.forms().viewedClasses().has(cls);
	},

	/** An app class placed itself where an object type is wanted (`Forms.viewedStaticClasses`): Swift views it as that type. */
	viewedStatics(this: ValueStates, cls: ts.ClassLikeDeclaration): boolean {
		return !this.backend.library && this.forms().viewedStaticClasses().has(cls);
	},

	/** Whether an object type reads a `viewedClass`'s member: under `xmlMemberKeys`, only the members those types name. */
	viewedMember(this: ValueStates, cls: ts.ClassLikeDeclaration, name: string): boolean {
		const keys = this.backend.library ? undefined : this.forms().viewedClasses().get(cls);
		return !!keys && (!this.backend.xmlMemberKeys || keys.has(name));
	},

	/** An app class whose statics script reaches by name (`Forms.byNameStaticClasses`), or an object type does (`Forms.viewedStaticClasses`). */
	byNameStatics(this: ValueStates, cls: ts.ClassLikeDeclaration): boolean {
		return !this.backend.library && !this.packaged(cls) && (this.forms().byNameStaticClasses().has(cls) || this.forms().viewedStaticClasses().has(cls));
	},
};

export type ByNameMethods = typeof byNameMethods;
