// @app-lenient
// @cli-program
// A shape whose method the program replaces on an object, so the shape is held untyped: its class-typed members read
// and called through it, destructured, and passed on.
class Strip {
  shown = true;
  constructor(readonly name: string) {}
  toggle(shown: boolean): void {
    this.shown = shown;
  }
}

interface Chrome {
  bar: Strip;
  rail: Strip;
  mode(rail: boolean): void;
  prefersRail(): boolean;
}

const patched = new WeakSet<Chrome>();

function collapse(chrome: Chrome): void {
  const { rail } = chrome;
  chrome.bar.toggle(false);
  rail.toggle(chrome.rail.name.length > 9);
  console.log('collapsed', chrome.bar.name, chrome.bar.shown, rail.shown);
}

function patch(chrome: Chrome): void {
  if (patched.has(chrome)) return;
  patched.add(chrome);
  const mode = chrome.mode.bind(chrome);
  chrome.mode = (rail: boolean) => {
    mode(rail);
    collapse(chrome);
  };
}

class Tabs {
  private _chrome = {
    bar: new Strip('bar'),
    rail: new Strip('rail'),
    mode(rail: boolean) {
      console.log('mode', rail, this.bar.shown);
    },
    prefersRail() {
      return false;
    },
  };
}

const chrome = (new Tabs() as unknown as { _chrome?: Chrome | null })._chrome;
if (chrome) {
  patch(chrome);
  patch(chrome);
  chrome.mode(chrome.prefersRail());
  chrome.bar.toggle(true);
  console.log(chrome.bar.shown, chrome.rail.shown);
}
