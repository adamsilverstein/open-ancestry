const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/** A byte count for people: `64 MB`, `1.1 GB`, `512 bytes` (1 KB = 1024 bytes). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}
