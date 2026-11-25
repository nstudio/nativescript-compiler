// @swift ledger:nativeSdk
// A native object the platform gives as nil where its typings say present (`NSURL.URLWithString('http://[')`): script holds
// null, the program's own test sees it, and a member read of it is JavaScript's TypeError there.
const BAD = 'http://[';
function open(s: string): string {
  const url = NSURL.URLWithString(s);
  if (!url) return 'none';
  return url.absoluteString;
}
function read(s: string): string {
  try {
    const url = NSURL.URLWithString(s);
    return url.absoluteString;
  } catch (e) {
    return (e as Error).name;
  }
}
function given(url: NSURL): string {
  return url ? url.absoluteString : 'missing';
}
class Link {
  url: NSURL = NSURL.URLWithString(BAD);
  text(): string {
    return this.url ? this.url.absoluteString : 'unset';
  }
}
console.log(open(BAD), open('https://a.b/'), read(BAD), read('https://c.d/'), given(NSURL.URLWithString(BAD)), given(NSURL.URLWithString('https://e.f/')), new Link().text());
