export const entry = 'exports';
export const pick = (names: string[]) => names.filter((n) => n.length > 3).join('+');
