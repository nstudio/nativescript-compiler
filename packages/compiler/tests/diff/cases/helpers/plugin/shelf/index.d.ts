import { BaseOffer } from './common';
export declare class Offer extends BaseOffer {
  constructor(id: string, n: number);
}
export declare class Shelf {
  static all(): Offer[];
}
