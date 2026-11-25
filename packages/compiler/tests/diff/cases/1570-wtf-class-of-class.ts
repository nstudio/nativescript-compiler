// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): an instance of a class expression with a method named class.
console.log('typeof new class { class() {} }()', typeof new (class { // wtfjs: A class of class
  class() {
    return 'class';
  }
})());
