import { hub, Hub } from './hub-core.ts';

declare module './hub-core.ts' {
  interface Hub extends HubMail {}
}

export interface HubMail {
  mail(): Mail;
}

let defaultMail: Mail;

export class Mail {
  sent: string[] = [];
  constructor() {
    if (defaultMail) return defaultMail;
    defaultMail = this;
  }
  send(to: string) {
    this.sent.push(to);
    return this.sent.length;
  }
}

const h = hub();
Object.defineProperty(h, 'mail', {
  value: () => {
    if (!defaultMail) defaultMail = new Mail();
    return defaultMail;
  },
  writable: false,
});
