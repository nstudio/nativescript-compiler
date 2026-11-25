class Sheet {
  constructor(name) {
    this.name = name;
  }
  shown = [];
  show(title, pinned = false) {
    const line = `${this.name}: ${title}${pinned ? " (pinned)" : ""}`;
    return this.shown.push(line), line.toUpperCase();
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
