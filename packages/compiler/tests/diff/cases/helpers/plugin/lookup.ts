// A plugin's async lookup whose promise is of an object and which gives null when nothing is found.
export class Entry {
  constructor(public name: string) {}
}

export async function lookup(name: string): Promise<Entry> {
  await Promise.resolve(0);
  if (name.length > 2) return new Entry(name);
  return null;
}
