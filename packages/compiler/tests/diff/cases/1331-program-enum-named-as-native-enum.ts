// A program enum named as a native enum's Swift name (NSComparisonResult is Swift's `ComparisonResult`): the program's
// cases stay its own, and a native comparison keeps its native result type.
enum ComparisonResult { Before = 'before', Same = 'same', After = 'after' }
const native = typeof NSString !== 'undefined';
function order(a: string, b: string): ComparisonResult {
  if (native) {
    const r: NSComparisonResult = NSString.stringWithString(a).compare(b);
    return r === NSComparisonResult.OrderedAscending ? ComparisonResult.Before : r === NSComparisonResult.OrderedSame ? ComparisonResult.Same : ComparisonResult.After;
  }
  return a < b ? ComparisonResult.Before : a === b ? ComparisonResult.Same : ComparisonResult.After;
}
const all: ComparisonResult[] = [order('a', 'b'), order('b', 'b'), order('c', 'b')];
console.log(all.join(' '), Object.values(ComparisonResult).length);
