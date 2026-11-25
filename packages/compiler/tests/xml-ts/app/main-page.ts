import { EventData, Frame, NavigatedData, Page } from '@nativescript/core';
import { HelloWorldModel } from './main-view-model';

export function navigatingTo(args: NavigatedData) {
  const page = <Page>args.object;
  page.bindingContext = new HelloWorldModel();
}

export function onCodeBehindTap(args: EventData) {
  const page = (<any>args.object).page as Page;
  (page.bindingContext as HelloWorldModel).set('message', 'From the code-behind');
}

export function onOpenList(args: EventData) {
  Frame.topmost().navigate({ moduleName: 'list-page', animated: false });
}
