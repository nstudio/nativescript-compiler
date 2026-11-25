// @lenient-both
// Library mode: a field written by name (`o[key] = v`) makes its key as a typed write does, in the order the writes run,
// and copying the object key by key keeps that order.
class Settings {
  theme: string;
  zoom: number;
  locale: string;
  version = 1;
}
const s = new Settings();
const any: any = s;
any['zoom'] = 2;
any['locale'] = 'en';
any.extra = true;
console.log(Object.keys(s).join(), JSON.stringify(s));
const copy: any = {};
for (const k in s) copy[k] = any[k];
console.log(Object.keys(copy).join(), JSON.stringify(copy));
s.theme = 'dark';
console.log(Object.keys(s).join(), Object.values(s).join());
