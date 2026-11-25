class Sheet {
  constructor(name) {
    this.name = name;
  }
  shown = [];
  show(title, pinned = false) {
    const line = `${this.name}: ${title}${pinned ? " (pinned)" : ""}`;
    this.shown.push(line);
    return line;
  }
  get count() {
    return this.shown.length;
  }
}
function describe(sheet) {
  return `${sheet.name} shown ${sheet.count} time${sheet.count === 1 ? "" : "s"}`;
}
export {
  Sheet,
  describe
};
//# sourceMappingURL=index.js.map
