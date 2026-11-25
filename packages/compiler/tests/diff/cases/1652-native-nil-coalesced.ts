// @swift ledger:nativeSdk
// `a ?? b` of two native objects the platform may give as nil: the right one where the left is nil, and nil where both
// are, which the program tests for.
const BAD = 'http://[';
function either(a: string, b: string): string {
  const url = NSURL.URLWithString(a) ?? NSURL.URLWithString(b);
  if (!url) return 'neither';
  return url.absoluteString;
}
function inline(a: string, b: string): string {
  return (NSURL.URLWithString(a) ?? NSURL.URLWithString(b)) ? 'some' : 'none';
}
console.log(either(BAD, BAD), either(BAD, 'https://c.d/'), either('https://a.b/', BAD), inline(BAD, BAD), inline(BAD, 'https://g.h/'));
