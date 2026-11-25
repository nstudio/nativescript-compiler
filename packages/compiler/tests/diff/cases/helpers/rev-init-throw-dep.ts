console.log('dep-before');
throw new Error('dep-boom');
export const depTag = 'unreachable';
