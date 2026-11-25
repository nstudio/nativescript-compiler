// The columns of test262's results (run.ts --report) and the one a test's result falls in; tests/checks/docs.ts classifies
// baseline.json's entries by it to hold README.md's table to the baseline.

/**
 * The report's columns, each a share of the selection: what is not counted (out of scope, a harness include not ported,
 * an adaptation that fails under Node), then what is: passing, refused by the translator (a build error naming the
 * construct), rejected by the type check, a build that fails (swiftc or kotlinc rejects the output, or the translator
 * throws), and a program that runs but not as JavaScript does (a wrong value, an uncaught error, a crash, a timeout).
 */
export const COLUMNS = ['out of scope', 'harness not ported', 'fails under Node', 'pass', 'refused', 'type check rejected', 'compile error', 'wrong output'] as const;
export type Column = (typeof COLUMNS)[number];
export function columnOf(r: { status: string; detail?: string }): Column {
  switch (r.status) {
    case 'out-of-scope': return 'out of scope';
    case 'unported': return 'harness not ported';
    case 'invalid': return 'fails under Node';
    case 'refused': return r.detail?.startsWith('type check') ? 'type check rejected' : 'refused';
    case 'fail': return /^(swiftc|kotlinc|translator threw)\b/.test(r.detail ?? '') ? 'compile error' : 'wrong output';
    default: return 'pass';
  }
}

/** What a `wrong output` result showed when it ran. */
export const WRONG_OUTPUT_KINDS = ['an assertion failed', 'an error the test does not expect', 'a crash or a timeout', 'an async test that never finished'] as const;
export function wrongOutputKind(detail: string): (typeof WRONG_OUTPUT_KINDS)[number] {
  if (/^(threw |async: )Test262Error\b/.test(detail)) return 'an assertion failed';
  if (/^(crashed|timeout)\b/.test(detail)) return 'a crash or a timeout';
  if (/^async: \$DONE not called/.test(detail)) return 'an async test that never finished';
  return 'an error the test does not expect';
}
