/**
 * A pipeline: processors linked into a chain.
 *
 * Frames are injected at the head and travel downstream as each processor
 * forwards them. Assembling the chain is the pipeline's job, so a caller
 * never has to wire the processors together by hand.
 */

import { type Frame } from "../frames/index.ts";
import { FrameProcessor } from "./frame-processor.ts";

export class Pipeline {
  readonly #processors: readonly FrameProcessor[];

  /**
   * @param processors The stages, in order from input to output. They are
   *   linked together; each one must not already be linked.
   */
  constructor(processors: readonly FrameProcessor[]) {
    if (processors.length === 0) {
      throw new Error("A pipeline needs at least one processor");
    }

    for (let i = 0; i + 1 < processors.length; i++) {
      processors[i]!.link(processors[i + 1]!);
    }

    this.#processors = [...processors];
  }

  /** The stages, in order from input to output. */
  get processors(): readonly FrameProcessor[] {
    return this.#processors;
  }

  /** The first stage, where frames are injected. */
  get head(): FrameProcessor {
    return this.#processors[0]!;
  }

  /** The last stage, where frames leave the pipeline. */
  get tail(): FrameProcessor {
    return this.#processors[this.#processors.length - 1]!;
  }

  /**
   * Inject a frame at the head.
   *
   * The frame travels downstream only while the stages are running, so start
   * them before injecting anything.
   *
   * @param frame The frame to inject.
   * @throws {QueueClosedError} If the head has already stopped.
   */
  push(frame: Frame): void {
    this.head.enqueue(frame);
  }
}
