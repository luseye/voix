/**
 * How long a reply takes to be heard.
 *
 * The number that decides whether a voice agent feels usable is the gap
 * between the user finishing a question and hearing the first audio of the
 * answer. Everything that gap is made of — endpointing, recognition, the
 * model's first token, synthesis' first chunk — happens between two frames the
 * pipeline already carries, so measuring it needs no instrumentation inside
 * any stage: an observer at the tail timestamps one and waits for the other.
 *
 * The observer only watches. Frames pass through untouched, so it can sit
 * anywhere that sees both kinds, and its presence changes nothing about the
 * conversation it is timing.
 */

import { FrameProcessor } from "./frame-processor.ts";
import { type Frame } from "../frames/index.ts";

/** One completed measurement, in milliseconds. */
export interface LatencySample {
  /** The measured gap, from the stop of speech to the first audio heard. */
  readonly ms: number;
  /** When the measurement completed, as a Unix timestamp. */
  readonly at: number;
}

/** How the observer is configured. */
export interface LatencyObserverOptions {
  /**
   * Called each time a measurement completes.
   *
   * For logging as turns happen; a session that only reports at the end is a
   * session nobody is watching while it runs.
   */
  readonly onSample?: (sample: LatencySample) => void;
}

export class LatencyObserver extends FrameProcessor {
  readonly #onSample: ((sample: LatencySample) => void) | undefined;

  /** When the user last stopped speaking, while a reply is still pending. */
  #stoppedAt: number | undefined;

  /** Every completed measurement, in completion order. */
  readonly #samples: LatencySample[] = [];

  constructor(options: LatencyObserverOptions = {}, name?: string) {
    super(name ?? "LatencyObserver");
    this.#onSample = options.onSample;
  }

  /** Every completed measurement, in completion order. */
  get samples(): readonly LatencySample[] {
    return [...this.#samples];
  }

  /**
   * A summary of the samples so far.
   *
   * Empty until one measurement has completed; an average over nothing would
   * be a number invented rather than measured.
   */
  get report(): { count: number; min: number; avg: number; max: number } | undefined {
    if (this.#samples.length === 0) {
      return undefined;
    }

    const values = this.#samples.map((sample) => sample.ms);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      count: values.length,
      min: Math.min(...values),
      avg: total / values.length,
      max: Math.max(...values),
    };
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "userStoppedSpeaking") {
      this.#stoppedAt = Date.now();
    } else if (frame.kind === "userStartedSpeaking") {
      // A reply that was interrupted never got heard, so the gap it would
      // have closed is not a latency anyone experienced. Drop the pending
      // measurement rather than report a number for audio that never played.
      this.#stoppedAt = undefined;
    } else if (frame.kind === "ttsAudio" && this.#stoppedAt !== undefined) {
      // The first chunk only: later chunks measure the length of the reply,
      // which is not what makes a conversation feel responsive.
      const sample: LatencySample = { ms: Date.now() - this.#stoppedAt, at: Date.now() };
      this.#stoppedAt = undefined;
      this.#samples.push(sample);
      this.#onSample?.(sample);
    }

    this.push(frame);
  }
}
