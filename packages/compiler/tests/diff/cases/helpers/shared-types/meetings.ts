export interface Meeting {
  id: number;
  title: string;
  zoomUrl?: string;
}

export type Room = { floor: number; name: string };

export function describe(m: Meeting, r: Room): string {
  return `${m.id} ${m.title} ${m.zoomUrl ?? 'no link'} @ ${r.name}/${r.floor}`;
}
