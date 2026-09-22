/**
 * Barge-in: the user talking over the bot.
 *
 * While the bot is speaking, the user's voice is an instruction to stop — but
 * only the user's. The bot's own voice is in the room too, a microphone hears
 * it, and acting on *that* would make the bot interrupt itself the moment it
 * started talking, every time.
 *
 * So the decision is narrow by design: an interruption fires only when the bot
 * is actually speaking, and only for speech the VAD has confirmed — five
 * windows, 160 ms of it — not for a stray loud window. It also holds a short
 * cooldown right after the bot starts, the window where echo of the bot's own
 * first audio is most likely to be mistaken for the user.
 *
 * The controller does not know how to interrupt anything. It is told, through
 * a callback, at assembly time — the place that builds the pipeline is the
 * place that owns it, and a stage holding a reference back to its own pipeline
 * would be a cycle.
 */

import { FrameProcessor } from "./frame-processor.ts";
import { type Frame } from "../frames/index.ts";

/**
 * How long after the bot starts speaking an interruption is suppressed.
 *
 * 200 ms is the road-map's guard against the bot hearing itself: room echo of
 * its first syllable can reach the microphone inside that window. Speech that
 * starts after it is the user.
 */
export const ECHO_GUARD_MS = 200;

/** How the turn controller is configured. */
export interface TurnControllerOptions {
  /**
   * Called when the user has talked over the bot and the reply should stop.
   *
   * Usually `() => pipeline.interrupt()`. Given at assembly time, when the
   * pipeline exists to be interrupted.
   */
  readonly onInterrupt: () => void;
  /** The echo guard, in milliseconds. Defaults to `ECHO_GUARD_MS`. */
  readonly echoGuardMs?: number;
}

export class TurnController extends FrameProcessor {
  readonly #onInterrupt: () => void;
  readonly #echoGuardMs: number;

  /** Whether the bot is currently speaking, so interrupts fire only then. */
  #botSpeaking = false;

  /** When the bot started, for the echo guard. */
  #startedAt = 0;

  /**
   * @param options The interrupt callback and the guard window.
   * @param name A label for logs.
   */
  constructor(options: TurnControllerOptions, name?: string) {
    super(name ?? "TurnController");

    this.#onInterrupt = options.onInterrupt;
    this.#echoGuardMs = options.echoGuardMs ?? ECHO_GUARD_MS;
  }

  /** Whether the bot is currently speaking. */
  get isBotSpeaking(): boolean {
    return this.#botSpeaking;
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "botStartedSpeaking") {
      this.#botSpeaking = true;
      this.#startedAt = Date.now();
    } else if (frame.kind === "botStoppedSpeaking") {
      this.#botSpeaking = false;
    } else if (frame.kind === "userStartedSpeaking" && this.#botSpeaking) {
      // The VAD has already required 160 ms of speech, so this is a real
      // voice. What is left to decide is whose it is, and the echo guard
      // answers that: inside the window right after the bot started, the
      // likeliest explanation for sound is the bot itself.
      if (Date.now() - this.#startedAt >= this.#echoGuardMs) {
        this.#botSpeaking = false;
        this.#onInterrupt();
      }
    }

    this.push(frame);
  }
}
