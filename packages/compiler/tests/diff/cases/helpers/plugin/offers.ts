export interface Pack { name: string }

export class Offer {
  id: string;
  packages: Array<Pack>;
  constructor(id: string, n: number) {
    this.id = id;
    this.packages = [];
    for (let i = 0; i < n; i++) this.packages.push({ name: id + i });
  }
}

export class Board {
  marked: Pack[];
  mark(p: Pack[]) { this.marked = p; }
  first(): string {
    const marks = this.marked;
    return (this.marked?.[0]?.name ?? 'none') + '/' + (marks?.[1]?.name ?? 'none');
  }
}
