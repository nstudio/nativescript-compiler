// @app-lenient
// Fields set to null passed on once set: to a parameter of their type, to an optional parameter while
// tested set, and returned where their type goes; the optional parameter given nothing once it holds null again.
import '@angular/compiler';
import { Injectable, Injector, inject, runInInjectionContext } from '@angular/core';

class Panel {
  name = 'panel';
}

function greet(name: string): string { return `hi ${name}`; }
function close(panel?: Panel): string { return panel ? `closed ${panel.name}` : 'none'; }
function twice(n: number): number { return n * 2; }

@Injectable({ providedIn: 'root' })
class Sheets {
  private panel: Panel = null;
  private title: string = null;
  private size: number = null;
  open(): string {
    this.panel = new Panel();
    this.title = 'T';
    this.size = 3;
    return `${greet(this.title)} ${twice(this.size)} ${this.shut()} ${this.current().name}`;
  }
  shut(): string {
    if (this.panel) return close(this.panel);
    return close();
  }
  current(): Panel { return this.panel; }
  kept(): string {
    this.panel = null;
    return `${this.panel === null} ${this.shut()}`;
  }
}

const injector = Injector.create({ providers: [{ provide: Sheets, useClass: Sheets }] });
runInInjectionContext(injector, () => {
  const s = inject(Sheets);
  console.log(s.open());
  console.log(s.kept());
});
