// A generic call whose type argument is an anonymous object type, resolved with an untyped parsed value and awaited.
class Client {
  fetch<T>(body: string): Promise<T> {
    return Promise.resolve(JSON.parse(body));
  }
  later<T>(body: string): Promise<T> {
    return new Promise<T>((resolve) => setTimeout(() => resolve(JSON.parse(body)), 0));
  }
}

function settled<T>(work: () => Promise<T>): Promise<T> {
  return work();
}

const client = new Client();
const body = '{"items":[{"name":"a"},{"name":"b"}],"total":2}';
const order: string[] = [];

async function main() {
  const viaPromise = await client.fetch<{ items: any[]; total: number }>(body);
  console.log(viaPromise.total, viaPromise.items[0].name);
  const viaLater = await client.later<{ items: { name: string }[] }>(body);
  console.log(viaLater.items[1].name);
  const viaGeneric = await settled(() => client.fetch<{ total: number }>(body));
  console.log(viaGeneric.total);
  const mapped = await client.fetch<{ items: { name: string }[] }>(body).then((v) => v.items.map((i) => i.name));
  console.log(mapped.join(','));
  const list = await client.fetch<{ name: string }[]>('[{"name":"x"}]');
  console.log(list[0].name, list.length);
  try {
    const missing = await client.fetch<{ total: number } | null>('null');
    console.log(missing === null);
  } catch (e) {
    console.log('caught', (e as Error).name);
  }
  const p = client.fetch<{ total: number }>(body);
  p.then(() => order.push('then'));
  Promise.resolve().then(() => order.push('a')).then(() => order.push('b'));
  await p;
  order.push('await');
  await null;
  console.log(order.join(' '));
}
main();
