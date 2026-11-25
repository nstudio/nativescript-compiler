import ts from 'typescript';
import type { RefusalId } from './refusals.ts';
import type { Ledger } from './ledger.ts';

/** The typings of the platform a build does not bind (`Ledger.nativeSdk`): what they declare only the other platform's code holds. */
export function otherPlatformTypings(ledger: Pick<Ledger, 'nativeSdk'>): RegExp {
	return ledger.nativeSdk === 'apple' ? /[\\/]@nativescript[\\/]types-android[\\/]/ : /[\\/]@nativescript[\\/]types-ios[\\/]/;
}

/**
 * The worker API's globals both platforms type (program.ts `WORKER_GLOBALS`), which only Android's kit runs: an iOS build
 * refuses each, where the platform's own names (Darwin's `close`) would otherwise take their place.
 */
const IOS_REFUSED: Readonly<Record<string, RefusalId>> = { Worker: 'worker', postMessage: 'worker', close: 'worker', URL: 'library-member' };

/** The refusal an iOS build gives `e` where it is, or is read from, one of those globals; null otherwise. */
export function iosRefusedGlobal(e: ts.Expression, checker: ts.TypeChecker): { id: RefusalId; name: string } | null {
	let x: ts.Expression = e;
	while (ts.isNewExpression(x) || ts.isCallExpression(x) || ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) || ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
	if (!ts.isIdentifier(x) || !Object.hasOwn(IOS_REFUSED, x.text)) return null;
	const decls = checker.getSymbolAtLocation(x)?.declarations ?? [];
	return decls.length && decls.every((d) => d.getSourceFile().fileName === '/__shims__/globals.d.ts') ? { id: IOS_REFUSED[x.text], name: x.text } : null;
}
