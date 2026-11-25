// Constructs one platform cannot hold, refused by the ledger's entry for it (ledger.ts `ONE_BACKEND_REFUSALS`).
import ts from 'typescript';
import { containsJump } from './ast.ts';
import type { Ledger } from './ledger.ts';

/** A string literal's text holding a lone surrogate, which strings of whole characters cannot hold. */
export function refusedString(text: string, ledger: Ledger): boolean {
	return ledger.wholeCharacterStrings && !text.isWellFormed();
}

/** A `return` or `throw` in `s`'s finally block, where control cannot leave one. */
export function refusedFinally(s: ts.TryStatement, ledger: Ledger): boolean {
	return !ledger.finallyJumps && !!s.finallyBlock && (containsJump(s.finallyBlock, ts.SyntaxKind.ReturnStatement) || containsJump(s.finallyBlock, ts.SyntaxKind.ThrowStatement));
}
