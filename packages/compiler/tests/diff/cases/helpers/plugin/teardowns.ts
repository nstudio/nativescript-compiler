export function arrRemove<T>(arr: T[] | undefined | null, item: T) {
  if (arr) {
    const index = arr.indexOf(item);
    0 <= index && arr.splice(index, 1);
  }
}

export function arrAdd<T>(arr: T[], item: T): T[] {
  arr.push(item);
  return arr;
}

export type Teardown = Link | (() => void);

export class Link {
  private parentage: Link[] | Link | null = null;
  private finalizers: Teardown[] | null = null;
  constructor(public name: string) {}
  addParent(p: Link): void {
    const { parentage } = this;
    if (Array.isArray(parentage)) parentage.push(p);
    else this.parentage = parentage ? [parentage, p] : p;
  }
  removeParent(p: Link): void {
    const { parentage } = this;
    if (parentage === p) this.parentage = null;
    else if (Array.isArray(parentage)) arrRemove(parentage, p);
  }
  add(t: Teardown): void {
    (this.finalizers = this.finalizers ?? []).push(t);
  }
  remove(t: Teardown): void {
    const { finalizers } = this;
    finalizers && arrRemove(finalizers, t);
  }
  parents(): string {
    const { parentage } = this;
    return Array.isArray(parentage) ? parentage.map((p) => p.name).join(',') : parentage ? parentage.name : '-';
  }
  count(): number {
    return this.finalizers ? this.finalizers.length : 0;
  }
  held(): Link[] | Link | null {
    return this.parentage;
  }
}

export class Chain {
  links: Link[] = [];
  drop(l: Link): void {
    arrRemove(this.links, l);
  }
}
