/**
 * A pipeline: processors linked into a chain.
 *
 * Frames are injected at the head and travel downstream as each processor
 * forwards them. Assembling the chain is the pipeline's job, so a caller
 * never has to wire the processors together by hand.
 */

import { createFrame, type Frame } from "../frames/index.ts";
import { FrameProcessor } from "./frame-processor.ts";

/** The sample rates a session runs at, carried by the start frame. */
export interface SessionRates {
  readonly sampleRateIn: number;
  readonly sampleRateOut: number;
}

export class Pipeline {
  readonly #processors: readonly FrameProcessor[];
  #completion: Promise<void> | undefined;
  #stopped = false;

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

  /** Whether the pipeline has been started and has not stopped yet. */
  get isRunning(): boolean {
    return this.#completion !== undefined && !this.#stopped;
  }

  /**
   * Interrupt every stage, aborting in-flight work and dropping queued work.
   *
   * Every stage is visited directly rather than the interrupt travelling as a
   * frame: a broadcast frame would need a rule against looping back on itself,
   * and a stage that fails to forward it would leave the rest of the pipeline
   * running. Visiting the stages is predictable and cannot be cut short.
   *
   * @returns The total number of queued frames dropped.
   */
  interrupt(): number {
    let dropped = 0;
    for (const processor of this.#processors) {
      dropped += processor.interrupt();
    }
    return dropped;
  }

  /**
   * Start every stage and inject the start frame.
   *
   * The loops all start together, before the start frame is injected.
   * Awaiting one loop before starting the next would deadlock: a loop returns
   * only once its queue closes, which is what `stop` does.
   *
   * @param rates The sample rates for the session.
   * @returns A promise that settles once the pipeline has stopped.
   * @throws If the pipeline has already been started.
   */
  start(rates: SessionRates): Promise<void> {
    if (this.#completion !== undefined) {
      throw new Error("Pipeline has already been started");
    }

    const runs = this.#processors.map((processor) => processor.run());
    this.push(createFrame({ kind: "start", ...rates }));

    const completion = Promise.all(runs)
      .then(() => undefined)
      .catch((error: unknown) => {
        // One stage failing leaves the rest waiting for frames that will never
        // come, so stop them before reporting the failure.
        for (const processor of this.#processors) {
          processor.close();
        }
        throw error;
      })
      .finally(() => {
        this.#stopped = true;
      });

    this.#completion = completion;
    return completion;
  }

  /**
   * Stop every stage and wait for them all to exit.
   *
   * The end frame is injected at the head and travels downstream. Being a
   * system frame, it is scheduled ahead of data frames still queued, so a stop
   * is immediate rather than a drain: a data frame that has not reached a
   * stage by the time the end frame does is dropped. Wait for a frame to be
   * handled before stopping if it has to be delivered.
   *
   * @returns A promise that settles once every stage has exited.
   * @throws If the pipeline has not been started.
   */
  async stop(): Promise<void> {
    if (this.#completion === undefined) {
      throw new Error("Pipeline has not been started");
    }

    if (!this.#stopped) {
      // A false return means the head had already stopped on its own.
      this.push(createFrame({ kind: "end" }));
    }

    await this.#completion;
  }
}
