// Spreading a value that may be undefined (which spreads nothing) into a typed object of optional fields.
interface Opts { size?: number; name?: string; tags?: string[] }
interface Holder { opts?: Opts; id: number }

function withName(o: Opts | undefined, name: string): Opts {
  return { ...o, name };
}

function bump(h: Holder): Holder {
  return { ...h, opts: { ...h.opts, size: (h.opts?.size ?? 0) + 1 } };
}

console.log(JSON.stringify(withName(undefined, 'a')), JSON.stringify(withName({ size: 2, tags: ['t'] }, 'b')));
const w = withName({ size: 3 }, 'c');
console.log(w.size, w.name, w.tags === undefined);
console.log(JSON.stringify(bump({ id: 1 })), JSON.stringify(bump({ id: 2, opts: { name: 'n', size: 4 } })));
