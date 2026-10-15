/** Pure domain logic shared by the server, CLI and web app. No I/O. */
export function appName(): string {
  return 'open-ancestry';
}

export * from './dates';
export * from './names';
export * from './living';
export * from './layout';
export * from './relationship';
export * from './kin';
export * from './escape';
