import { Label, StackLayout } from '@nativescript/core';

export class Card extends StackLayout {
  private label = new Label();

  constructor() {
    super();
    this.className = 'card';
    this.label.className = 'card-title';
    this.addChild(this.label);
  }

  get title(): string {
    return this.label.text;
  }

  set title(value: string) {
    this.label.text = value;
  }
}
