import { Injectable } from '@angular/core';

export class Source<T> {
  readonly items: T[] = [];

  constructor(readonly name: string) {}

  add(item: T): number {
    return this.items.push(item);
  }

  describe(): string {
    return `${this.name} of ${this.items.length}`;
  }
}

@Injectable()
export class Store<T> extends Source<T> {
  pushes = 0;

  constructor() {
    super('store');
  }

  push(item: T): number {
    this.pushes++;
    return this.add(item);
  }
}

@Injectable()
export class ComponentStore<T> {
  state?: T;

  patch(s: T) {
    this.state = s;
  }
}
