/**
 * Cutting a streamed reply into sentences.
 *
 * A model streams its reply a fragment at a time, and speech synthesis wants
 * whole sentences rather than fragments: a synthesised fragment has no sentence
 * to shape its intonation around, so the audio sounds wrong and the pacing is
 * uneven. This sits between the two and does the cutting.
 *
 * Cutting as soon as a sentence is complete is also what keeps the first words
 * quick. Waiting for the whole reply would mean waiting for the model to finish
 * before the user heard anything at all.
 */

import { FrameProcessor } from "./frame-processor.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** Characters that end a sentence, in both scripts this is likely to meet. */
const TERMINATORS = new Set([".", "!", "?", ";", "。", "！", "？", "；"]);

/**
 * The longest piece of text handed to synthesis at once.
 *
 * A model that never punctuates would otherwise leave the whole reply sitting
 * in the buffer, unheard, until the stream ended. This is a safety valve for
 * that case, not the normal path.
 */
export const MAX_SENTENCE_LENGTH = 200;

/** Whether a character is a digit, for telling a decimal point from a full stop. */
function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Where to cut a run of text that has outgrown the limit.
 *
 * At the last space that fits, so a word is only split when it is longer than
 * the limit by itself — cutting mid-word sounds worse than cutting
 * mid-sentence. Text with no spaces, such as Chinese, is cut at the limit.
 *
 * @param text Text known to be longer than the limit.
 * @returns The index to cut at, exclusive.
 */
function cutPoint(text: string): number {
  const space = text.lastIndexOf(" ", MAX_SENTENCE_LENGTH);
  return space > 0 ? space + 1 : MAX_SENTENCE_LENGTH;
}

/**
 * Append text to a list, cutting it into pieces no longer than the limit.
 *
 * @param text The text to append, which is emitted whole when it fits.
 * @param into The list to append to.
 */
function appendCapped(text: string, into: string[]): void {
  while (text.length > MAX_SENTENCE_LENGTH) {
    const cut = cutPoint(text);
    into.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  into.push(text);
}

/**
 * Take the complete sentences off the front of a buffer.
 *
 * @param text The text to read.
 * @returns The complete sentences, and whatever is left over — a sentence still
 *   being written, which the caller keeps and prepends to the next fragment.
 */
export function takeSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!TERMINATORS.has(char)) {
      continue;
    }

    // A dot between digits is a decimal point, so "3.14" is one number and not
    // two sentences.
    if (char === "." && isDigit(text[i - 1]) && isDigit(text[i + 1])) {
      continue;
    }

    appendCapped(text.slice(start, i + 1), sentences);
    start = i + 1;
  }

  // Whatever follows the last terminator is a sentence still being written, so
  // it stays behind. A run-on cannot be left to grow without bound, though, so
  // it is cut down to the limit and the tail kept for next time.
  let rest = text.slice(start);
  while (rest.length > MAX_SENTENCE_LENGTH) {
    const cut = cutPoint(rest);
    sentences.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  return { sentences, rest };
}

export class SentenceAggregator extends FrameProcessor {
  /** Text seen so far that is not yet a complete sentence. */
  #buffer = "";

  /**
   * @param name A label for logs.
   */
  constructor(name?: string) {
    super(name ?? "SentenceAggregator");
  }

  /**
   * Drop the text that has not been spoken yet.
   *
   * An interruption means the user has started talking over the reply, so the
   * rest of it is no longer wanted. Frames already queued for synthesis are
   * dropped by the base class, but the text still in this buffer is not a
   * frame: without clearing it here it would be spoken as soon as the reply's
   * end marker arrived — words the user has already moved past.
   *
   * @returns How many queued frames were dropped.
   */
  override interrupt(): number {
    this.#buffer = "";
    return super.interrupt();
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "llmText") {
      this.#buffer += frame.text;
      const { sentences, rest } = takeSentences(this.#buffer);
      this.#buffer = rest;

      for (const sentence of sentences) {
        const text = sentence.trim();
        // Whitespace between sentences is not a sentence of its own.
        if (text.length > 0) {
          this.push(createFrame({ kind: "ttsText", text }));
        }
      }

      // The reply is forwarded as well as cut. Synthesis wants the sentences,
      // but the text still has to reach the end of the pipeline to be recorded
      // in the conversation, and the text is what it is recorded from.
      this.push(frame);
      return;
    }

    if (frame.kind === "llmTextEnded") {
      // The reply is over, so whatever is left is its last sentence even though
      // nothing punctuated it.
      const text = this.#buffer.trim();
      this.#buffer = "";

      if (text.length > 0) {
        this.push(createFrame({ kind: "ttsText", text }));
      }

      this.push(frame);
      return;
    }

    this.push(frame);
  }
}
