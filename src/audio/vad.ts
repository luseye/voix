/**
 * Turn-taking from speech probability.
 *
 * The Silero model answers "is this window speech?" with a number, but a
 * number is not a turn: the model fires on every window, a cough scores as
 * high as a word, and a pause inside a sentence scores low. This is the state
 * machine between the two — it watches the probabilities and reports only the
 * moments a listener would call speaking and stopping.
 *
 * The report is deliberately迟钝 in both directions. Speech must hold above
 * the threshold for several windows before `userStartedSpeaking` is emitted,
 * so a cough or a door slam is not a turn, and silence must hold below it for
 * several more before `userStoppedSpeaking` is, so a pause between words does
 * not end one. The cost is latency on both edges — `START_WINDOWS` and
 * `STOP_WINDOWS` of it — which is the trade every VAD threshold makes.
 */

import { toFloatSamples } from "./pcm.ts";
import { FrameProcessor } from "../core/frame-processor.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** The probability above which a window counts as speech. */
export const SPEECH_THRESHOLD = 0.5;

/**
 * How many consecutive speech windows start a turn.
 *
 * Five windows is 160 ms: shorter than any word, long enough to ride out a
 * click or a breath.
 */
export const START_WINDOWS = 5;

/**
 * How many consecutive silent windows end a turn.
 *
 * Twenty-four windows is about 770 ms, a conversational pause. Ending on
 * anything shorter cuts a speaker off mid-sentence; this is the same knob
 * Deepgram's endpointing turns, here under our own control.
 */
export const STOP_WINDOWS = 24;

/** The part of the Silero model the state machine needs. */
export interface ProbabilitySource {
  /**
   * Score audio, one probability per complete 512-sample window.
   *
   * @param samples 16 kHz mono audio, -1 to 1.
   * @returns One speech probability per complete window, in order.
   */
  process(samples: Float32Array): Promise<number[]>;
}

/** How detection is configured. */
export interface VADOptions {
  /** The probability source, usually a loaded `SileroVAD`. */
  readonly source: ProbabilitySource;
  /** The probability above which a window counts as speech. Defaults to `SPEECH_THRESHOLD`. */
  readonly threshold?: number;
  /** Speech windows required before a start is believed. Defaults to `START_WINDOWS`. */
  readonly startWindows?: number;
  /** Silent windows required before a stop is believed. Defaults to `STOP_WINDOWS`. */
  readonly stopWindows?: number;
}

/** Whether the detector currently believes someone is speaking. */
type State = "listening" | "speaking";

export class VADProcessor extends FrameProcessor {
  readonly #source: ProbabilitySource;
  readonly #threshold: number;
  readonly #startWindows: number;
  readonly #stopWindows: number;

  #state: State = "listening";
  // Windows counted towards the edge being confirmed, reset whenever a window
  // argues against it.
  #run = 0;

  /**
   * @param options The probability source and the thresholds.
   * @param name A label for logs.
   */
  constructor(options: VADOptions, name?: string) {
    super(name ?? "VAD");

    this.#source = options.source;
    this.#threshold = options.threshold ?? SPEECH_THRESHOLD;
    this.#startWindows = options.startWindows ?? START_WINDOWS;
    this.#stopWindows = options.stopWindows ?? STOP_WINDOWS;
  }

  /** Whether the detector currently believes someone is speaking. */
  get isSpeaking(): boolean {
    return this.#state === "speaking";
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "inputAudio") {
      await this.#onAudio(frame.data);
      // The audio itself is forwarded: recognition still needs it, and a VAD
      // that swallowed the audio would silence everything downstream.
    }

    this.push(frame);
  }

  /** Score one frame of audio and report any edge the state machine confirms. */
  async #onAudio(samples: Int16Array): Promise<void> {
    // The pipeline carries 16-bit samples; the model wants floats in -1..1.
    const probabilities = await this.#source.process(toFloatSamples(samples));

    for (const probability of probabilities) {
      this.#onWindow(probability);
    }
  }

  /** Fold one probability into the state machine, emitting on confirmed edges. */
  #onWindow(probability: number): void {
    const isSpeech = probability >= this.#threshold;

    if (this.#state === "listening") {
      this.#run = isSpeech ? this.#run + 1 : 0;
      if (this.#run >= this.#startWindows) {
        this.#state = "speaking";
        this.#run = 0;
        this.push(createFrame({ kind: "userStartedSpeaking" }));
      }
      return;
    }

    // Speaking: only sustained silence ends the turn.
    this.#run = isSpeech ? 0 : this.#run + 1;
    if (this.#run >= this.#stopWindows) {
      this.#state = "listening";
      this.#run = 0;
      this.push(createFrame({ kind: "userStoppedSpeaking" }));
    }
  }
}
