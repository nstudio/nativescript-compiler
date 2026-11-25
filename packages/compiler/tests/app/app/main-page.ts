import { NavigatedData, Page } from '@nativescript/core';
import { KitModel } from './kit-model';

export function navigatingTo(args: NavigatedData) {
  (<Page>args.object).bindingContext = new KitModel();
}
