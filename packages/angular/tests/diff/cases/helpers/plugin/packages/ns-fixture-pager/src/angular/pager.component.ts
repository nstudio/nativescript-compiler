import { Component } from '@angular/core';
import { Pager } from 'ns-fixture-pager';

@Component({ selector: 'FixturePager', template: '' })
export class PagerComponent {
  private readonly pager = new Pager('component');
  get nativeElement(): Pager {
    return this.pager;
  }
}
