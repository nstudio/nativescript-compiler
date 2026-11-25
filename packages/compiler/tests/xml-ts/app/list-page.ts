import { ItemEventData, NavigatedData, Observable, Page } from '@nativescript/core';

const fruits = [
  { name: 'Apples', count: 3 },
  { name: 'Pears', count: 7 },
  { name: 'Plums', count: 12 },
];

export function navigatingTo(args: NavigatedData) {
  const page = <Page>args.object;
  const model = new Observable();
  model.set('fruits', fruits);
  model.set('badge', '3 kinds');
  model.set('picked', 'Nothing picked');
  page.bindingContext = model;
}

export function onItemTap(args: ItemEventData) {
  const page = (<any>args.object).page as Page;
  (page.bindingContext as Observable).set('picked', 'Picked ' + fruits[args.index].name);
}
