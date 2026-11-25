export class Entry {
  constructor(public path: string) {}
}

export function chooseEntry(path: string): Promise<Entry> {
  return new Promise<Entry>((resolve) => {
    if (!path) {
      resolve(null);
      return;
    }
    setTimeout(() => resolve(new Entry(path)), 0);
  });
}
