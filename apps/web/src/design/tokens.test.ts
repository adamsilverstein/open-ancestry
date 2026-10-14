import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

/** Returns a token's [light, dark] hex values from tokens.css. */
function token(name: string): [string, string] {
  const match = css.match(new RegExp(`--oa-${name}:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`Missing token --oa-${name}`);
  const value = match[1].trim();
  const pair = value.match(/^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i);
  if (pair) return [pair[1]!, pair[2]!];
  if (/^#[0-9a-f]{6}$/i.test(value)) return [value, value];
  throw new Error(`--oa-${name} is not a hex color or light-dark() pair: ${value}`);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** [foreground, background, minimum ratio] in both themes. */
const pairs: [string, string, number][] = [
  // Focus rings are non-text UI: 3:1 against what they sit on (WCAG 1.4.11).
  ['focus-surface', 'surface', 3],
  ['focus-surface', 'bg', 3],
  ['focus-canvas', 'canvas', 3],
  ['canvas-text', 'canvas', 4.5],
  ['canvas-text-muted', 'canvas', 4.5],
  ['border-strong', 'surface', 3],
  ['text', 'bg', 4.5],
  ['text-muted', 'surface', 4.5],
  ['text-muted', 'surface-sunken', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'surface-selected', 3],
  ['accent-contrast', 'accent', 4.5],
  ['danger', 'surface', 4.5],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, string, number] => [`tag-${n}`, 'surface', 4.5]),
];

describe('token contrast', () => {
  for (const [fg, bg, min] of pairs) {
    it(`--oa-${fg} on --oa-${bg} is at least ${min}:1 in both themes`, () => {
      const [fgLight, fgDark] = token(fg);
      const [bgLight, bgDark] = token(bg);
      expect(contrast(fgLight, bgLight)).toBeGreaterThanOrEqual(min);
      expect(contrast(fgDark, bgDark)).toBeGreaterThanOrEqual(min);
    });
  }

  it('the surface focus color fails on the canvas, which is why canvas areas switch', () => {
    expect(contrast(token('focus-surface')[0], token('canvas')[0])).toBeLessThan(3);
  });
});
