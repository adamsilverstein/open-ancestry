import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { editKey, editsSettled } from './edits';

describe('editsSettled', () => {
  it('resolves at once when nothing is pending, else when the last edit settles', async () => {
    const client = new QueryClient();
    await editsSettled(client, 'Tree');

    let finish: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const order: string[] = [];
    const mutation = client.getMutationCache().build(client, {
      mutationKey: editKey('Tree'),
      mutationFn: () => slow.then(() => order.push('edit')),
    });
    const running = mutation.execute(undefined);
    const waited = editsSettled(client, 'Tree').then(() => order.push('settled'));
    // Another tree's edits are not waited for.
    await editsSettled(client, 'Other');
    finish();
    await running;
    await waited;
    expect(order).toEqual(['edit', 'settled']);
  });
});
