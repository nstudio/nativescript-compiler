class Pager {
  constructor(name) {
    this.name = name;
    this.selectedIndex = 0;
  }
  next() {
    return ++this.selectedIndex;
  }
}
export {
  Pager
};
//# sourceMappingURL=index.js.map
