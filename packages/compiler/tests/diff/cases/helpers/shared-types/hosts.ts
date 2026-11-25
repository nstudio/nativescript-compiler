interface Meeting {
  title: string;
  host?: { name: string };
}

type Room = { seats: number };

function initials(m: Meeting): string {
  return m.host ? m.host.name.split(' ').map((p) => p[0]).join('') : '-';
}

export function hostLine(): string {
  const meetings: Meeting[] = [{ title: 'TSC sync', host: { name: 'Ada Lovelace' } }, { title: 'Office hours' }];
  const room: Room = { seats: 8 };
  return `${meetings.map(initials).join(',')} ${room.seats}`;
}
