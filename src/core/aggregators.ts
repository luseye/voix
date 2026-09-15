/**
 * The two ends of a conversation, turned into history.
 *
 * A model needs the conversation so far, but a pipeline delivers that
 * conversation as many small frames: speech recognition reports an utterance in
 * pieces, and the model streams its reply a token at a time. Something has to
 * put the pieces back together and record them, and that is these two.
 *
 * They are separate because they sit at opposite ends of the pipeline. What the
 * user said is assembled on the way in, before the model runs; what the model
 * said is assembled on the way out, after the reply has been spoken.
 */

import { FrameProcessor } from "./frame-processor.ts";
import { LLMContext } from "./context.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/**
 * Assembles what the user said into one message, and starts the model.
 *
 * Only final transcripts are kept. An interim result is the recogniser's best
 * guess at a sentence still being spoken, and it is replaced as the guess
 * improves; recording one would put text in the history that the user never
 * said.
 *
 * The pieces are held until the user stops speaking rather than being recorded
 * as they arrive. One utterance can be reported in several final results, and
 * recording each separately would leave the history reading as a series of
 * fragments instead of one thing the user said.
 */
export class UserAggregator extends FrameProcessor {
  readonly #context: LLMContext;

  /** Final transcript pieces for the utterance in progress. */
  #pending: string[] = [];

  /**
   * @param context The history to record into.
   * @param name A label for logs.
   */
  constructor(context: LLMContext, name?: string) {
    super(name ?? "UserAggregator");
    this.#context = context;
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "transcript") {
      if (frame.final) {
        this.#pending.push(frame.text);
      }
      // Forwarded either way: an interim result is of no use to the history but
      // is still useful to whatever is showing the user their own words.
      this.push(frame);
      return;
    }

    if (frame.kind === "userStoppedSpeaking") {
      const text = this.#pending.filter((piece) => piece.length > 0).join(" ").trim();
      this.#pending = [];

      // Silence is not a turn. Without this, a pause in a quiet room would ask
      // the model to reply to nothing.
      if (text.length > 0) {
        this.#context.addMessage({ role: "user", content: text });
        this.push(createFrame({ kind: "llmRun" }));
      }

      this.push(frame);
      return;
    }

    this.push(frame);
  }
}

/**
 * Assembles the model's reply into one message and records it.
 *
 * The pieces are joined without a separator because they are fragments of the
 * same text, not separate utterances: a model streams "hel", "lo" and means
 * "hello", so joining with a space would corrupt the words.
 *
 * Recording waits for the end-of-reply marker rather than happening as the
 * pieces arrive, because until then there is no knowing whether the reply is
 * finished or was cut short by an interruption.
 */
export class AssistantAggregator extends FrameProcessor {
  readonly #context: LLMContext;

  /** Pieces of the reply in progress. */
  #pending: string[] = [];

  /**
   * @param context The history to record into.
   * @param name A label for logs.
   */
  constructor(context: LLMContext, name?: string) {
    super(name ?? "AssistantAggregator");
    this.#context = context;
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "llmText") {
      this.#pending.push(frame.text);
      this.push(frame);
      return;
    }

    if (frame.kind === "llmTextEnded") {
      const text = this.#pending.join("").trim();
      this.#pending = [];

      // An empty reply is not recorded. A model can emit nothing at all — on a
      // cancelled turn, for instance — and an empty assistant message would be
      // a turn that never happened.
      if (text.length > 0) {
        this.#context.addMessage({ role: "assistant", content: text });
      }

      this.push(frame);
      return;
    }

    this.push(frame);
  }
}
