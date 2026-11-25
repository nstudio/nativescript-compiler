export class Sheet {
  private shown: string[] = [];
  constructor(readonly name: string) {}
  show(title: string, pinned = false): string {
    const line = `${this.name}: ${title}${pinned ? ' (pinned)' : ''}`;
    this.shown.push(line);
    return line;
  }
  get count(): number {
    return this.shown.length;
  }
}

export function describe(sheet: Sheet): string {
  return `${sheet.name} shown ${sheet.count} time${sheet.count === 1 ? '' : 's'}`;
}
