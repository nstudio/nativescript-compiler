// What both backends know of a library function or method, one table per family (math.ts, globals.ts, console.ts,
// …): how many arguments it reads, whether it may throw, what it gives, and the operation (`op`) each backend spells.
// A family's member its table lacks is refused alike on both backends. tests/semantics/ holds each entry to what
// Node answers.
import type ts from 'typescript';
import type { AsyncSyntax } from '../async.ts';
import type { RefusalId } from '../refusals.ts';
import type { SharedOp } from '../runtime.ts';

/**
 * How a plain runtime call takes an argument: `value` as written, `any` as any value, `string`, `key` (a property key),
 * `iterable` and `callback` converted so, `rest` every argument as written.
 */
export type ArgForm = 'value' | 'any' | 'string' | 'key' | 'iterable' | 'callback' | 'rest';

/** What a call gives, as `typeof` names it; `any`: an element or a value the arguments give, of any type. */
export type ApiResult = 'number' | 'string' | 'boolean' | 'undefined' | 'bigint' | 'symbol' | 'object' | 'function' | 'any';

export interface ApiEntry<Op extends string = string> {
	/** `method`: of an instance (`s.trim()`); `static`: of a namespace or constructor (`Math.floor`); `global`: a global function. */
	readonly kind: 'method' | 'static' | 'global';
	/** JavaScript's `length` of the function: the arguments it reads before its optional and rest ones. */
	readonly arity: number;
	/** It reads every argument after them too (`Math.max(a, b, c)`). */
	readonly rest?: true;
	/** It may throw for arguments its parameter types allow (`toFixed(101)`'s RangeError). */
	readonly throws: boolean;
	readonly result: ApiResult;
	readonly op: Op;
	/** The kit function both backends call for it, where they call one. */
	readonly runtime?: SharedOp;
	/** A call of it is a plain call of `runtime`, its arguments in these forms (`runtimeCall`). */
	readonly args?: readonly ArgForm[];
	/** A host's, not ECMAScript's (the web platform's timers, NativeScript's `cancel`): tests/semantics/ asks Node nothing of it. */
	readonly host?: true;
	/** NativeScript's binding of one native SDK (`Array.create` of Java arrays): there only. */
	readonly sdk?: 'apple' | 'android';
	/**
	 * The kit for this SDK declares the function under its library name (kit-android's AnimationFrame.kt): a call of it is
	 * a call of the declared function, which the backend spells as any other.
	 */
	readonly declaredBy?: 'apple' | 'android';
	/** Both backends refuse a call of it with this. */
	readonly refuse?: RefusalId;
}

export type ApiTable<Op extends string> = Readonly<Record<string, ApiEntry<Op>>>;

/** An entry's facts, its kind and op aside. */
export type ApiFacts = Omit<ApiEntry, 'kind' | 'op' | 'throws'> & { readonly throws?: true };

/** A family's table of members of one `kind`, each its own operation. */
export function apiTable<Op extends string>(kind: ApiEntry['kind'], facts: { readonly [K in Op]: ApiFacts }): ApiTable<Op> {
	return Object.freeze(Object.fromEntries((Object.keys(facts) as Op[]).map((op) => [op, Object.freeze({ ...facts[op], kind, op, throws: !!facts[op].throws })])));
}

/** `table`'s entry for `name`; null where the family has no such member. */
export function apiEntry<Op extends string>(table: ApiTable<Op>, name: string): ApiEntry<Op> | null {
	return Object.hasOwn(table, name) ? table[name] : null;
}

/** The translator methods that spell a plain runtime call's arguments, alike in both backends. */
export interface CallArguments {
	readonly syntax: AsyncSyntax;
	expr(e: ts.Expression): string;
	restArgument(call: ts.CallExpression, x: ts.Expression, type: string): string;
	str(e: ts.Expression): string;
	propertyKey(e: ts.Expression): string;
	iterable(e: ts.Expression): string;
	callback(e: ts.Expression): string;
	args(call: ts.CallExpression): string[];
}

/** `call` of `entry`, which has `args`: its runtime function given each argument in its form. */
export function runtimeCall(t: CallArguments, entry: ApiEntry, call: ts.CallExpression): string {
	const arg = (form: ArgForm, k: number): string[] => {
		const x = call.arguments[k];
		switch (form) {
			case 'rest':
				return t.args(call);
			case 'value':
				return [t.expr(x)];
			case 'any':
				return [t.restArgument(call, x, t.syntax.untypedType)];
			case 'string':
				return [t.str(x)];
			case 'key':
				return [t.propertyKey(x)];
			case 'iterable':
				return [t.iterable(x)];
			case 'callback':
				return [t.callback(x)];
		}
	};
	return `${t.syntax.runtime[entry.runtime!]}(${entry.args!.flatMap(arg).join(', ')})`;
}
