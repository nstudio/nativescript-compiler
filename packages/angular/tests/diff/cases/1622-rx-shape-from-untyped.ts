// An observable of untyped values read as an anonymous object type: firstValueFrom, lastValueFrom, subscribe and map.
import { Observable, firstValueFrom, lastValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

function get<T>(body: string): Observable<T> {
  return new Observable<any>((subscriber) => {
    subscriber.next(JSON.parse(body));
    subscriber.complete();
  });
}

const body = '{"items":[{"name":"a"},{"name":"b"}],"total":2}';

async function main() {
  const first = await firstValueFrom(get<{ items: any[] }>(body));
  console.log(first.items.length, first.items[1].name);
  const last = await lastValueFrom(get<{ total: number }>(body));
  console.log(last.total);
  get<{ total: number }>(body).subscribe((v) => console.log('next', v.total));
  const names = await firstValueFrom(get<{ items: { name: string }[] }>(body).pipe(map((v) => v.items.map((i) => i.name))));
  console.log(names.join(','));
}
main();
