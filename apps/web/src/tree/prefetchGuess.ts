/**
 * The one re-focus guess being prepared: a dwell timer, then a neighborhood
 * fetch. A newer guess cancels the older one's fetch, but once the focus moves
 * (the user re-focused, maybe on the guessed person) the in-flight fetch is
 * left alone: the real re-focus may be awaiting that same query.
 */
export class PrefetchGuess<R> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: R | null = null;
  private readonly dwellMs: number;
  private readonly cancel: (request: R) => void;

  constructor(dwellMs: number, cancel: (request: R) => void) {
    this.dwellMs = dwellMs;
    this.cancel = cancel;
  }

  /**
   * Replaces the current guess, cancelling its fetch, and runs `start` after
   * the dwell. `start` begins the fetch and returns its request and a promise
   * that settles when it ends.
   */
  next(start: () => { request: R; done: Promise<unknown> }) {
    this.drop(true);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const { request, done } = start();
      this.request = request;
      const clear = () => {
        if (this.request === request) this.request = null;
      };
      done.then(clear, clear);
    }, this.dwellMs);
  }

  /** The focus moved: stop a waiting guess, but never cancel its fetch from now on. */
  adopt() {
    this.drop(false);
  }

  private drop(cancelFetch: boolean) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (cancelFetch && this.request !== null) this.cancel(this.request);
    this.request = null;
  }
}
