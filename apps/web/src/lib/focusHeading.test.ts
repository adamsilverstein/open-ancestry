import { afterEach, describe, expect, it } from 'vitest';
import { focusMainHeading } from './focusHeading';

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

afterEach(() => {
  document.body.innerHTML = '';
});

function page() {
  const main = document.createElement('main');
  document.body.append(main);
  return main;
}

describe('focusMainHeading', () => {
  it('focuses the h1 once it renders', async () => {
    const main = page();
    focusMainHeading();
    await frame();
    const h1 = document.createElement('h1');
    main.append(h1);
    await frame();
    await frame();
    expect(document.activeElement).toBe(h1);
    expect(h1.tabIndex).toBe(-1);
  });

  it('stops if the user moves focus while the page loads', async () => {
    const main = page();
    focusMainHeading();
    await frame();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const h1 = document.createElement('h1');
    main.append(h1);
    await frame();
    await frame();
    expect(document.activeElement).toBe(button);
  });
});
