import { hub, Hub } from './hub-core.ts';

declare module './hub-core.ts' {
  interface Hub extends HubConfig {}
}

export interface HubConfig {
  config(owner?: Hub): Config;
}

export class Config {
  constructor(public owner: string) {}
  fetch(key: string): Promise<string> {
    return Promise.resolve(`${key}@${this.owner}`);
  }
}

let defaultConfig: Config;
const byOwner = new Map<Hub, Config>();

Object.defineProperty(hub(), 'config', {
  value: (owner?: Hub) => {
    if (!owner) {
      if (!defaultConfig) defaultConfig = new Config('default');
      return defaultConfig;
    }
    if (!byOwner.has(owner)) byOwner.set(owner, new Config(owner.name));
    return byOwner.get(owner);
  },
  writable: false,
});
