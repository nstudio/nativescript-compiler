// `undefined` reaching a field typed `T | null | undefined` through `any` stays undefined, not null.
interface Opts { tint?: string | null; size?: number }
const raw: any = JSON.parse('{"t": null}');
const gone: any = undefined;
const c: Opts = { tint: raw.t as string | null | undefined, size: 1 };
const d: Opts = { tint: gone as string | null | undefined, size: 2 };
const e: Opts = { tint: Math.random() > 2 ? null : (gone as any as string | undefined), size: 3 };
for (const o of [c, d, e]) {
  const v: any = o.tint;
  console.log(JSON.stringify(o), v === null, v === undefined, 'tint' in o, Object.keys(o).join(','));
}
const pick = (n: number, x: any): Opts => ({ tint: n > 0 ? (x as string | null | undefined) : 'kept', size: n });
for (const o of [pick(1, null), pick(2, undefined), pick(0, null), pick(3, 'given'), pick(-1, undefined)]) console.log(JSON.stringify(o), 'tint' in o, o.tint === undefined);
