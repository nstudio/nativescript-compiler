// Adapted from wtfjs (github.com/denysdovhan/wtfjs, WTFPL): a return in finally replaces the try block's return.
// @refused-swift return or throw in a finally block is not supported in a release build yet
const finallyWins: any = () => { // wtfjs: Insidious `try..catch`
  try {
    return 2;
  } finally {
    return 3;
  }
};
console.log('try return 2 finally return 3', finallyWins()); // wtfjs: Insidious `try..catch`
