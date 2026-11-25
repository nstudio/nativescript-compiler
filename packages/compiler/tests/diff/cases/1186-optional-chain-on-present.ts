// `?.` written on values that are never null or undefined: inside a chain, after a call, on a field.
interface Segment { path: string }
interface Snapshot { data: Record<string, string>; url: Segment[] }
class Route {
  snapshot: Snapshot = { data: { title: 'home' }, url: [{ path: 'start' }] };
  child?: Route;
}

class Steps {
  prompts: string[] = ['one', 'two'];
  current = 1;
  prompt(): string { return this.prompts?.[this.current] ?? 'none'; }
}

function describe(r: Route | undefined): string {
  const title = r?.snapshot?.data['title'] || 'untitled';
  const first = r?.snapshot?.url?.[0]?.path || 'nowhere';
  const query = 'b=2&a=1'.split('&')?.sort()?.join('&');
  return `${title} ${first} ${query}`;
}

const root = new Route();
root.child = new Route();
console.log(describe(root), describe(undefined), describe(root.child), new Steps().prompt());
