// Shadow mode (NS_HELD_SHADOW=<file>): each placement whose carrier, as `readHeld` reads it, differs from the one the
// value states declare for the expression is recorded, one JSON line per placement.
import { appendFileSync } from 'node:fs';
import ts from 'typescript';
import type { Held } from '../../src/semantics/conversion.ts';
import type { PlacementBackend } from '../../src/semantics/placement.ts';

export function shadowHeld(b: PlacementBackend, e: ts.Expression, held: Held, target: string): void {
	const declared = b.states.heldType(e);
	if (declared.type.name === held.type.name && declared.rep === held.rep) return;
	const f = e.getSourceFile();
	const { line } = f.getLineAndCharacterOfPosition(e.getStart());
	appendFileSync(process.env.NS_HELD_SHADOW!, JSON.stringify({ file: f.fileName, line: line + 1, kind: ts.SyntaxKind[ts.skipOuterExpressions(e).kind], text: e.getText().slice(0, 60), declared: declared.type.name + (declared.rep === 'present' ? '' : '?' + declared.rep), held: held.type.name + (held.rep === 'present' ? '' : '?' + held.rep), checker: b.typeOf(e), target }) + '\n');
}
