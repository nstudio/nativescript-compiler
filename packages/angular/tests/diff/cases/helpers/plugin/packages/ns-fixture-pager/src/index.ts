export class Pager {
  selectedIndex = 0;
  constructor(readonly name: string) {}
  next(): number {
    return ++this.selectedIndex;
  }
}
