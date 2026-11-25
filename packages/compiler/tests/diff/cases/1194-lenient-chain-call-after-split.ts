// @app-lenient
// A non-strict app's chain through a split of an element that may be missing: the split's result is present, so
// the calls after it chain on it.
function sortedQuery(url: string) {
  var parts = url.split('?');
  var base = parts[0];
  var sorted = parts?.[1]?.split('&')?.sort()?.join('&') || '';
  return [base, sorted].filter(Boolean).join('?');
}

console.log(sortedQuery('a.pdf?z=1&b=2&m=3'));
console.log(sortedQuery('?q=1'));
