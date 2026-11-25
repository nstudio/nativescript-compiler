// The console's methods, each the runtime helper both kits define under one name. A call passes every argument on,
// since script evaluates them all; the helper reads those its method takes (a label, a condition, options) and
// formats the rest as console.log does.
import { apiEntry, type ApiEntry, type ApiTable } from './api.ts';
import type { SharedOp } from '../runtime.ts';

/** A console helper of both kits. */
export type ConsoleOp = Extract<SharedOp, 'jsLog' | 'jsError' | `JSConsole.${string}`>;

const OPS: Readonly<Record<string, ConsoleOp>> = {
	log: 'jsLog',
	info: 'jsLog',
	debug: 'jsLog',
	dirxml: 'jsLog',
	error: 'jsError',
	warn: 'jsError',
	assert: 'JSConsole.assert',
	count: 'JSConsole.count',
	countReset: 'JSConsole.countReset',
	dir: 'JSConsole.dir',
	group: 'JSConsole.group',
	groupCollapsed: 'JSConsole.group',
	groupEnd: 'JSConsole.groupEnd',
	table: 'JSConsole.table',
	time: 'JSConsole.time',
	timeEnd: 'JSConsole.timeEnd',
	timeLog: 'JSConsole.timeLog',
	trace: 'JSConsole.trace',
};

export const CONSOLE: ApiTable<ConsoleOp> = Object.freeze(Object.fromEntries(Object.entries(OPS).map(([name, op]) => [name, Object.freeze({ kind: 'static', arity: 0, rest: true, throws: false, result: 'undefined', op } satisfies ApiEntry<ConsoleOp>)])));

/** `console.<method>`; null for a method the kits do not provide, which is refused. */
export function consoleMethod(method: string): ApiEntry<ConsoleOp> | null {
	return apiEntry(CONSOLE, method);
}
