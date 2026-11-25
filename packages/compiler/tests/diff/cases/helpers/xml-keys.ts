// What core does by name to an XML app's objects, as generated XML code and core's Observable reach them: a read or a
// write by a key, and an attribute set on a view.
export function readKey(o: any, key: string): any {
  return o[key];
}
export function writeKey(o: any, key: string, value: any): void {
  o[key] = value;
}
export function setAttribute(v: any, name: string, value: string): void {
  v[name] = value;
}
