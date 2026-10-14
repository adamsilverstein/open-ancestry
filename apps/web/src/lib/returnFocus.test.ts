import { afterEach, describe, expect, it } from 'vitest';
import { captureOpener, lastControlOutside, returnFocus, trackFocus } from './returnFocus';

afterEach(() => {
  document.body.innerHTML = '';
});

function button(label: string, parent: HTMLElement = document.body) {
  const el = document.createElement('button');
  el.textContent = label;
  parent.append(el);
  return el;
}

describe('captureOpener', () => {
  it('returns the focused control', () => {
    const opener = button('Edit person');
    opener.focus();
    expect(captureOpener()).toBe(opener);
  });

  it('uses the last control outside overlays when a menu item has focus', () => {
    trackFocus();
    const trigger = button('Add family member');
    trigger.focus();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    const item = button('Add child', menu);
    item.focus();
    expect(captureOpener()).toBe(trigger);
  });

  it('keeps a control inside an open dialog, for nested confirms', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    const remove = button('Delete person', dialog);
    remove.focus();
    expect(captureOpener()).toBe(remove);
  });
});

describe('returnFocus', () => {
  it('skips removed elements and closing dialogs, then uses the fallback', () => {
    const gone = button('Edit Death');
    gone.remove();
    const closing = document.createElement('div');
    closing.setAttribute('role', 'dialog');
    closing.dataset.state = 'closed';
    document.body.append(closing);
    const inClosing = button('Delete event', closing);
    const add = button('Add event');
    expect(returnFocus(gone, inClosing, () => add)).toBe(true);
    expect(document.activeElement).toBe(add);
  });

  it('reports when nothing is usable', () => {
    expect(returnFocus(null, () => undefined)).toBe(false);
  });
});

describe('a dialog opened from the command palette', () => {
  it('returns to the last control outside overlays once the palette input is gone', () => {
    trackFocus();
    const find = button('Find');
    find.focus();
    const palette = document.createElement('div');
    palette.setAttribute('role', 'dialog');
    document.body.append(palette);
    const input = document.createElement('input');
    palette.append(input);
    input.focus();
    const opener = captureOpener();
    const outside = lastControlOutside();
    expect(opener).toBe(input);
    palette.remove();
    expect(returnFocus(opener, outside)).toBe(true);
    expect(document.activeElement).toBe(find);
  });
});
