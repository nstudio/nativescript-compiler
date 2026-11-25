// @lenient-both
// As core's Binding holds its source: a primitive binding context (a Repeater of strings) is wrapped with
// `new String(…)` / `new Number(…)` / `new Boolean(…)` so that `new WeakRef` accepts it.
class Binding {
  source: WeakRef<Object>;
  private sourceAsObject(source: any): any {
    const objectType = typeof source;
    if (objectType === 'number') {
      source = new Number(source);
    } else if (objectType === 'boolean') {
      source = new Boolean(source);
    } else if (objectType === 'string') {
      source = new String(source);
    }
    return source;
  }
  update(source: any) {
    source = this.sourceAsObject(source);
    if (source !== null && source !== undefined) {
      this.source = new WeakRef(source);
    }
  }
}
const read: string[] = [];
for (const context of ['window attached', 42, true, { title: 'row' }]) {
  const b = new Binding();
  b.update(context);
  const held = b.source.deref() as any;
  read.push(`${held}|${held == context}|${held.title ?? '-'}`);
}
console.log(read.join(', '));
