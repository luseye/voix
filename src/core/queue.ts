/**
 * An asynchronous queue.
 *
 * Producers `push` items; a consumer awaits `pop`. An empty queue suspends the
 * consumer until something arrives, so a processing loop can simply await its
 * next item instead of polling.
 */

/** Raised when pushing to a queue that has been closed. */
export class QueueClosedError extends Error {
  constructor() {
    super("Cannot push to a closed queue");
    this.name = "QueueClosedError";
  }
}

export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((item: T | undefined) => void)[] = [];
  #closed = false;

  /** Number of items waiting. */
  get size(): number {
    return this.#items.length;
  }

  /** Whether no items are waiting. */
  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  /** Whether the queue has been closed. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Add an item, waking a waiting consumer if there is one.
   *
   * @param item The item to enqueue.
   * @throws {QueueClosedError} If the queue has been closed.
   */
  push(item: T): void {
    if (this.#closed) {
      throw new QueueClosedError();
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      // Hand the item straight over rather than queueing it. This is safe
      // because a consumer only waits while the queue is empty, so the item
      // would be at the front anyway.
      waiter(item);
      return;
    }

    this.#items.push(item);
  }

  /**
   * Remove and return the next item, waiting if the queue is empty.
   *
   * @returns The next item, or `undefined` once the queue is closed and drained.
   */
  async pop(): Promise<T | undefined> {
    if (this.#items.length > 0) {
      // Non-null: the length check guarantees an item is present. Testing the
      // shifted value instead would misfire if T itself admits undefined.
      return this.#items.shift()!;
    }

    if (this.#closed) {
      return undefined;
    }

    return new Promise<T | undefined>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /**
   * Close the queue.
   *
   * Items already queued stay available, so a consumer drains what is left
   * before it stops. Waiting consumers are released with `undefined`.
   */
  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter(undefined);
    }
  }
}
