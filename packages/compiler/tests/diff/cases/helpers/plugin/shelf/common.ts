export interface Pack { name: string }

export abstract class BaseOffer {
  public id: string;
  public packs: Array<Pack> = [];
}
