// @app-lenient
// Dot access on a value typed by an index signature or a Record reads and writes the key of that name.
interface Params { [key: string]: any }
function build(state?: 'cold' | 'warm', tag?: string): Params {
  const out: Params = { source: 'widget' };
  if (state) out.app_state = state;
  if (tag) out.tag = tag;
  out.count = (out.count ?? 0) + 1;
  return out;
}
const attrs: Record<string, string> = {};
attrs._campaign = 'spring';
attrs.channel = attrs._campaign + '-mail';
attrs.channel += '!';
console.log(JSON.stringify(build()), JSON.stringify(build('cold', 't')), JSON.stringify(attrs), attrs.missing === undefined);
