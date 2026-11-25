import { Injectable } from '@angular/core';

export class Source<T> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  get current(): T {
    return this.value;
  }
}

export class ListStore<T> extends Source<T[]> {
  constructor() {
    super([]);
  }

  push(item: T): number {
    return this.value.push(item);
  }

  last(): T | undefined {
    return this.current[this.current.length - 1];
  }

  joined(): string {
    return this.value.map((v) => String(v)).join(',');
  }
}

export class Pair<A, B> {
  constructor(public first: A, public second: B) {}
}

export class Named<T> extends Pair<string, T> {
  label(): string {
    return `${this.first.toUpperCase()}=${String(this.second)}`;
  }
}

@Injectable()
export class Counter<T> extends Source<T[]> {
  constructor() {
    super([]);
  }

  count(item: T): number {
    return this.value.push(item);
  }
}
