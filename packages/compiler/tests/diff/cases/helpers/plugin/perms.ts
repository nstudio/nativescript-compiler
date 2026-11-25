export namespace Perms {
  let status = 'undetermined';
  let asked = false;
  export async function getStatus(): Promise<[string, boolean]> {
    await Promise.resolve();
    status = asked ? 'authorized' : 'undetermined';
    return [status, true];
  }
  export async function request(): Promise<[string, boolean]> {
    const s = await getStatus();
    if (s[0] === 'undetermined') {
      asked = true;
      return getStatus();
    }
    return s;
  }
  export function requestPermission(type): Promise<[string, boolean]> {
    switch (type) {
      case 'notification':
        return request();
      case 'camera':
        return getStatus();
    }
  }
}

export async function request(permission: string): Promise<[string, boolean]> {
  return Perms.requestPermission(permission);
}
