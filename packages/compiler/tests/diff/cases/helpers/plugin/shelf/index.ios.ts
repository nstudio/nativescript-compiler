import { BaseOffer } from './common.ts';

export class Offer extends BaseOffer {
  constructor(id: string, n: number) {
    super();
    this.id = id;
    for (let i = 0; i < n; i++) this.packs.push({ name: id + i });
  }
}

export class Shelf {
  static async fetch(): Promise<Offer[]> {
    return [new Offer('a', 2), new Offer('b', 0)];
  }

  static all(): Offer[] {
    return [new Offer('a', 2), new Offer('b', 0)];
  }
}
