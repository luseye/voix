/**
 * The base class for frame handlers.
 *
 * A processor owns a priority queue and a main loop. The loop awaits the next
 * frame and hands it to `process`, which a subclass implements.
 *
 * The rule that matters most: `process` runs on the loop, so slow work inside
 * it stalls every frame behind it. Anything that outlives the frame which
 * triggered it does not belong there.
 */

import { type Frame, framePriority } from "../frames/index.ts";
import { AsyncQueue } from "./queue.ts";

export abstract class FrameProcessor {
  /** A label used in logs and error messages. */
  readonly name: string;

  readonly #queue = new AsyncQueue<Frame>(framePriority);
  #running = false;

  /**
   * @param name A label for logs. Defaults to the concrete class name.
   */
  constructor(name?: string) {
    this.name = name ?? this.constructor.name;
  }

  /** Whether the main loop is running. */
  get isRunning(): boolean {
    return this.#running;
  }

  /** The number of frames waiting to be handled. */
  get queueSize(): number {
    return this.#queue.size;
  }

  /**
   * Add a frame to this processor's queue.
   *
   * @param frame The frame to handle.
   * @throws {QueueClosedError} If the processor has stopped.
   */
  enqueue(frame: Frame): void {
    this.#queue.push(frame);
  }

  /**
   * Handle one frame.
   *
   * Runs on the main loop, so it must return promptly: a slow `process` holds
   * up every frame behind it. Anything that outlives the frame which triggered
   * it belongs somewhere other than here.
   *
   * @param frame The frame to handle.
   */
  protected abstract process(frame: Frame): Promise<void>;

  /**
   * Handle frames until the queue is closed.
   *
   * An `end` or `cancel` frame stops the loop: the queue is closed, whatever
   * is already queued drains, and the loop returns. That final frame is still
   * processed, so a subclass can flush and release resources.
   *
   * @returns A promise that settles once the loop has stopped.
   * @throws If the loop is already running.
   */
  async run(): Promise<void> {
    if (this.#running) {
      throw new Error(`${this.name} is already running`);
    }
    this.#running = true;

    try {
      while (true) {
        const frame = await this.#queue.pop();
        if (frame === undefined) {
          break;
        }

        if (frame.kind === "end" || frame.kind === "cancel") {
          // Refuse new work first, then handle this last frame so the subclass
          // can flush. Frames already queued still drain.
          this.#queue.close();
        }

        await this.process(frame);
      }
    } finally {
      this.#running = false;
      // This runs after a thrown frame too, so a failed loop never leaves
      // producers pushing into a queue that nobody reads.
      this.#queue.close();
    }
  }

  /** Stop the loop, letting queued frames drain first. */
  close(): void {
    this.#queue.close();
  }
}
