import { Sheet, describe } from 'ns-fixture-patched';
import { merged, type Options } from './options';

export class SheetService {
  private readonly sheet = new Sheet('service');
  open(options: Partial<Options> = {}): string {
    const o = merged(options);
    return this.sheet.show(o.title, o.pinned);
  }
  summary(): string {
    return describe(this.sheet);
  }
}
