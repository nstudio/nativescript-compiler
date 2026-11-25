import { SheetParams } from './params';

export class SheetService {
  private closed: string[] = [];
  open(context: string, done: (result: string) => void): SheetParams {
    return new SheetParams(context, (...args: any[]) => {
      const result = args.length ? `${context}:${args.join(',')}` : `${context}:none`;
      this.closed.push(result);
      done(result);
    });
  }
  get history(): string {
    return this.closed.join(' | ');
  }
}
