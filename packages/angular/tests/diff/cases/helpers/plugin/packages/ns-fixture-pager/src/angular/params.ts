export class SheetParams {
  constructor(
    public readonly context: any,
    public readonly closeCallback: (...args) => void,
  ) {}
}
