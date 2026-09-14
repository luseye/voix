/**
 * An asynchronous queue with optional priority ordering.
 *
 * Producers `push` items; a consumer awaits `pop`. An empty queue suspends the
 * consumer until something arrives, so a processing loop can simply await its
 * next item instead of polling.
 *
 * Items leave in ascending priority order — lower values first. Items of equal
 * priority leave in the order they arrived.
 */

/** Extracts an item's priority. Lower values are dequeued first. */
export type PriorityFn<T> = (item: T) => number;

/** Raised when pushing to a queue that has been closed. */
export class QueueClosedError extends Error {
  constructor() {
    super("Cannot push to a closed queue");
    this.name = "QueueClosedError";
  }
}

interface Entry<T> {
  readonly item: T;
  readonly priority: number;
}

export class AsyncQueue<T> {
  readonly #entries: Entry<T>[] = [];
  readonly #waiters: ((item: T | undefined) => void)[] = [];
  readonly #priorityOf: PriorityFn<T>;
  #closed = false;

  /**
   * @param priorityOf Extracts an item's priority. When omitted every item
   * shares one priority, so the queue behaves as a plain FIFO.
   */
  constructor(priorityOf?: PriorityFn<T>) {
    this.#priorityOf = priorityOf ?? (() => 0);
  }

  /** Number of items waiting. */
  get size(): number {
    return this.#entries.length;
  }

  /** Whether no items are waiting. */
  get isEmpty(): boolean {
    return this.#entries.length === 0;
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

    this.#insert({ item, priority: this.#priorityOf(item) });
  }

  /**
   * Remove and return the next item, waiting if the queue is empty.
   *
   * @returns The next item, or `undefined` once the queue is closed and drained.
   */
  async pop(): Promise<T | undefined> {
    if (this.#entries.length > 0) {
      // Non-null: the length check guarantees an entry is present. Testing the
      // shifted value instead would misfire if T itself admits undefined.
      return this.#entries.shift()!.item;
    }

    if (this.#closed) {
      return undefined;
    }

    return new Promise<T | undefined>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /**
   * Remove every waiting item that matches a predicate.
   *
   * Used to drop work that an interruption has made irrelevant. Items already
   * handed to a consumer are unaffected: a waiting consumer only exists while
   * the queue is empty, so removing entries can never disturb one.
   *
   * @param predicate Returns `true` for the items to drop.
   * @returns How many items were removed.
   */
  removeWhere(predicate: (item: T) => boolean): number {
    let removed = 0;

    // Backwards, so the indices ahead of the cursor stay valid as items go.
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (predicate(this.#entries[i]!.item)) {
        this.#entries.splice(i, 1);
        removed++;
      }
    }

    return removed;
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

  /**
   * Place an entry after every entry of equal or lower priority.
   *
   * Scanning for the first strictly greater priority is what keeps items of
   * equal priority in arrival order.
   */
  #insert(entry: Entry<T>): void {
    const index = this.#entries.findIndex((existing) => existing.priority > entry.priority);
    if (index === -1) {
      this.#entries.push(entry);
    } else {
      this.#entries.splice(index, 0, entry);
    }
  }
}
