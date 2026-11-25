export class Hub {
  constructor(public name: string) {}
  app() {
    return `app of ${this.name}`;
  }
}

let instance: Hub;

export function hub(): Hub {
  if (!instance) instance = new Hub('default');
  return instance;
}
