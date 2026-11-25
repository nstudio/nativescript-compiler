// @experimental-decorators
import { Inject, Injectable } from '@angular/core';

let made = 0;

export function madeCount(): number {
  return made;
}

@Injectable({ providedIn: 'root' })
export class Tally {
  count = 0;

  constructor() {
    made++;
  }

  bump(): number {
    return ++this.count;
  }
}

@Injectable({ providedIn: 'root' })
export class Ledger {
  readonly entries: string[] = [];

  constructor(@Inject(Tally) private readonly tally: Tally) {}

  record(entry: string): string {
    this.entries.push(entry);
    return `${entry} #${this.tally.bump()}`;
  }
}

@Injectable({ providedIn: 'root' })
export class Channel {
  sent: string[] = [];

  kind(): string {
    return 'plain';
  }

  send(text: string): number {
    return this.sent.push(`${this.kind()}:${text}`);
  }
}

@Injectable({ providedIn: 'root' })
export class LoudChannel extends Channel {
  override kind(): string {
    return 'loud';
  }
}

@Injectable({ providedIn: 'root' })
export class Settings {
  static shared = new Settings();

  theme: string;

  constructor() {
    this.theme = 'light';
  }
}
