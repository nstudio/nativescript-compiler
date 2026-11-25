// An object of a known shape assigned to, and passed as, a dictionary of another value type: its entries, by key.
function count(perms: { [key: string]: { reason: string } }) {
  return Object.keys(perms).map((k) => `${k}=${perms[k].reason}`).join(',');
}
function pick(mode: string) {
  let requested: { [key: string]: { reason: string } } = {};
  const mediaPerms = { photo: { reason: 'photos' }, video: { reason: 'videos' } };
  if (mode === 'image') requested['photo'] = mediaPerms['photo'];
  else requested = mediaPerms;
  console.log(count(requested), count(mediaPerms));
  const options: Record<string, { reason: string }> = mediaPerms;
  console.log(Object.keys(options).join(','), options['video'].reason);
}
pick('image');
pick('any');
