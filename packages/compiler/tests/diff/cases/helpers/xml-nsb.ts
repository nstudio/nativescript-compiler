// The run-time helpers of the XML binding closures, as src/xml/bindings.ts emits them (tests/xml-contexts-check.ts checks it).
const __nsbChain = Symbol('forcedChain');
export const __nsb = {
  scope(m: any, c: any, k: string): any {
    let x = k in c ? c : m;
    if (!(k in x)) x = global;
    return x;
  },
  id(m: any, c: any, k: string): any {
    return __nsb.scope(m, c, k)[k];
  },
  idFn(m: any, c: any, k: string, converter: boolean, back: boolean): any {
    const x = __nsb.scope(m, c, k);
    let v = x[k];
    if (converter) v = __nsb.conv(v, back);
    return typeof v === 'function' ? v.bind(x) : v;
  },
  conv(v: any, back: boolean): any {
    if (v === undefined || v === null) return v;
    if (typeof v === 'function') return back ? Function.prototype : v;
    if (typeof v === 'object' && (typeof v.toModel === 'function' || typeof v.toView === 'function')) return (back ? v.toModel : v.toView) || Function.prototype;
    return v;
  },
  // flags: 1 the object is an identifier, 2 the object of another member, 4 optional, 8 a converter, 16 called.
  member(o: any, p: any, flags: number, back: boolean): any {
    if (o == null && (flags & 1) !== 0) return (flags & 2) !== 0 ? __nsbChain : undefined;
    // Strict: no other value equals the module's own symbol, and the runtimes' loose equality of a string and a symbol recurses.
    if (o === __nsbChain) return (flags & 2) !== 0 ? o : undefined;
    let v = (flags & 4) !== 0 ? o?.[p] : o[p];
    if ((flags & 8) !== 0) v = __nsb.conv(v, back);
    return (flags & 16) !== 0 && typeof v === 'function' ? v.bind(o) : v;
  },
  callee(callback: any, optional: boolean): any {
    if (!optional && (callback === undefined || callback === null)) throw new Error('Cannot perform a call using a null or undefined property');
    return callback;
  },
  call(callback: any, optional: boolean, args: any[]): any {
    return optional ? callback?.(...args) : callback(...args);
  },
  construct(callback: any, args: any[], converter: boolean, back: boolean): any {
    const v = new callback(...args);
    return converter ? __nsb.conv(v, back) : v;
  },
  pipe(left: any, right: any): any {
    if (typeof right === 'function') return right(left);
    if (right === undefined || right === null) throw new Error('Cannot perform a call using a null or undefined property');
    throw new Error('Invalid converter syntax');
  },
  add(list: any[], value: any): any[] {
    list.push(value);
    return list;
  },
  spread(list: any[], value: any): any[] {
    list.push(...value);
    return list;
  },
  seq(first: any, value: any): any {
    return value;
  },
  assign(o: any, part: any): any {
    Object.assign(o, part);
    return o;
  },
  prop(k: any, v: any): any {
    return { [k]: v };
  },
};
