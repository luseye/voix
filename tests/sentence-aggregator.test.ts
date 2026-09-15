import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import {
  MAX_SENTENCE_LENGTH,
  SentenceAggregator,
  takeSentences,
} from "../src/core/sentence-aggregator.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Records every frame it sees. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }

  /** The sentences handed to synthesis, in order. */
  get sentences(): string[] {
    return this.seen
      .filter((frame) => frame.kind === "ttsText")
      .map((frame) => (frame as { text: string }).text);
  }

  /** The kinds seen, in order. */
  get kinds(): string[] {
    return this.seen.map((frame) => frame.kind);
  }
}

/** Waits until a condition holds, so tests do not depend on timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was never met");
}

describe("takeSentences", () => {
  test("takes a sentence that ends with a full stop", () => {
    expect(takeSentences("Hello there.")).toEqual({ sentences: ["Hello there."], rest: "" });
  });

  test("keeps an unfinished sentence as the remainder", () => {
    // The caller holds this until the rest of the sentence arrives.
    expect(takeSentences("Hello the")).toEqual({ sentences: [], rest: "Hello the" });
  });

  test("takes several sentences from one stretch of text", () => {
    expect(takeSentences("One. Two! Three?")).toEqual({
      sentences: ["One.", " Two!", " Three?"],
      rest: "",
    });
  });

  test("recognises every kind of terminator", () => {
    expect(takeSentences("a;b!c?d.").sentences).toEqual(["a;", "b!", "c?", "d."]);
  });

  test("recognises terminators from other scripts", () => {
    // A model answering in Chinese punctuates in Chinese.
    expect(takeSentences("你好。今天天气不错！").sentences).toEqual(["你好。", "今天天气不错！"]);
  });

  test("treats a decimal point as part of the number", () => {
    // Splitting "3.14" would send synthesis "3." and "14", which read as
    // something else entirely.
    expect(takeSentences("It is 3.14 metres. ")).toEqual({
      sentences: ["It is 3.14 metres."],
      rest: " ",
    });
  });

  test("still ends a sentence on a dot after a number", () => {
    // Only a dot *between* digits is a decimal point; a dot followed by a
    // space ends the sentence as usual.
    expect(takeSentences("It costs 5. Next.").sentences).toEqual(["It costs 5.", " Next."]);
  });

  test("takes nothing from empty text", () => {
    expect(takeSentences("")).toEqual({ sentences: [], rest: "" });
  });

  test("keeps a run-on below the limit whole", () => {
    const text = "a".repeat(MAX_SENTENCE_LENGTH);

    expect(takeSentences(text)).toEqual({ sentences: [], rest: text });
  });

  test("cuts a run-on at the last space that fits", () => {
    // A model that never punctuates must not stall the reply until the stream
    // ends, but cutting mid-word is worse than cutting mid-sentence.
    //
    // The leading "ab " is deliberate: without it the words divide the limit
    // exactly and a hard cut would land on a space by luck, so the test would
    // pass even if the cut ignored spaces.
    const text = `ab ${"word ".repeat(50)}end`;
    const { sentences, rest } = takeSentences(text);

    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(sentence.length).toBeLessThanOrEqual(MAX_SENTENCE_LENGTH);
      // Cut at a space, so the next piece starts a fresh word.
      expect(sentence.endsWith(" ")).toBe(true);
    }
    // Nothing is lost: the tail holds the rest of the run-on, up to its end.
    expect(rest.endsWith("end")).toBe(true);
  });

  test("cuts text with no spaces at the limit", () => {
    // Chinese has no spaces, so there is no space to cut at.
    const text = "字".repeat(MAX_SENTENCE_LENGTH + 10);
    const { sentences, rest } = takeSentences(text);

    expect(sentences).toEqual(["字".repeat(MAX_SENTENCE_LENGTH)]);
    expect(rest).toBe("字".repeat(10));
  });

  test("cuts a single sentence that outgrows the limit", () => {
    // Punctuation can be rarer than the limit, so a complete sentence is not
    // exempt from being cut.
    const text = `${"x".repeat(MAX_SENTENCE_LENGTH)}.`;
    const { sentences } = takeSentences(text);

    expect(sentences).toEqual(["x".repeat(MAX_SENTENCE_LENGTH), "."]);
  });
});

describe("SentenceAggregator", () => {
  test("hands a completed sentence to synthesis", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "Hello there." }));
    await until(() => spy.sentences.length === 1);

    expect(spy.sentences).toEqual(["Hello there."]);

    await pipeline.stop();
    await running;
  });

  test("waits for the sentence to be complete", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // A fragment is not a sentence; synthesising it would read it as one.
    pipeline.push(createFrame({ kind: "llmText", text: "Hello the" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spy.sentences).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("joins fragments that together make one sentence", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // A model streams a sentence across several chunks.
    pipeline.push(createFrame({ kind: "llmText", text: "Hel" }));
    pipeline.push(createFrame({ kind: "llmText", text: "lo the" }));
    pipeline.push(createFrame({ kind: "llmText", text: "re." }));
    await until(() => spy.sentences.length === 1);

    expect(spy.sentences).toEqual(["Hello there."]);

    await pipeline.stop();
    await running;
  });

  test("hands over several sentences from one chunk", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "One. Two." }));
    await until(() => spy.sentences.length === 2);

    expect(spy.sentences).toEqual(["One.", "Two."]);

    await pipeline.stop();
    await running;
  });

  test("keeps a sentence whole when its punctuation spans two chunks", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // The terminator arrives in the second chunk, so the first alone is not a
    // sentence and must not be spoken.
    pipeline.push(createFrame({ kind: "llmText", text: "Hello there" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy.sentences).toEqual([]);

    pipeline.push(createFrame({ kind: "llmText", text: "." }));
    await until(() => spy.sentences.length === 1);

    expect(spy.sentences).toEqual(["Hello there."]);

    await pipeline.stop();
    await running;
  });

  test("speaks the remainder when the reply ends without punctuation", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // The last sentence of a reply need not end in a terminator; the end of the
    // reply is what says it is over.
    pipeline.push(createFrame({ kind: "llmText", text: "Goodbye" }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.sentences.length === 1);

    expect(spy.sentences).toEqual(["Goodbye"]);

    await pipeline.stop();
    await running;
  });

  test("speaks nothing when the reply ended with no leftover text", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // The sentence was already handed over on the terminator, so the end marker
    // has nothing left to speak and must not emit an empty one.
    pipeline.push(createFrame({ kind: "llmText", text: "Done." }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    expect(spy.sentences).toEqual(["Done."]);

    await pipeline.stop();
    await running;
  });

  test("speaks nothing when only whitespace is left over", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // The space after the sentence is framing, not something to speak, so an
    // end marker with only that left must not emit a whitespace-only sentence.
    pipeline.push(createFrame({ kind: "llmText", text: "Done. " }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    expect(spy.sentences).toEqual(["Done."]);

    await pipeline.stop();
    await running;
  });

  test("trims whitespace around a sentence", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // The space between two sentences is framing, not something to speak.
    pipeline.push(createFrame({ kind: "llmText", text: "One. Two." }));
    await until(() => spy.sentences.length === 2);

    expect(spy.sentences).toEqual(["One.", "Two."]);

    await pipeline.stop();
    await running;
  });

  test("forwards the reply as well as cutting it", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "Hi." }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    // The text still has to reach the end of the pipeline to be recorded; the
    // sentences are an addition, not a replacement.
    expect(spy.kinds).toEqual(["start", "ttsText", "llmText", "llmTextEnded"]);

    await pipeline.stop();
    await running;
  });

  test("forwards frames it does not handle", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([1]) }));
    await until(() => spy.kinds.includes("inputAudio"));

    expect(spy.kinds).toContain("inputAudio");

    await pipeline.stop();
    await running;
  });

  test("drops text not yet spoken when the user interrupts", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // The user has started talking over the reply, so this unfinished sentence
    // is no longer wanted. It is not a frame, so only clearing the buffer stops
    // it being spoken when the reply's end marker arrives.
    pipeline.push(createFrame({ kind: "llmText", text: "I was about to say" }));
    await until(() => spy.kinds.includes("llmText"));

    pipeline.interrupt();
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    expect(spy.sentences).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("starts a fresh reply after an interruption", async () => {
    const aggregator = new SentenceAggregator();
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "half a sen" }));
    await until(() => spy.kinds.includes("llmText"));

    pipeline.interrupt();

    // The dropped fragment must not reappear glued to the next reply.
    pipeline.push(createFrame({ kind: "llmText", text: "A new reply." }));
    await until(() => spy.sentences.length === 1);

    expect(spy.sentences).toEqual(["A new reply."]);

    await pipeline.stop();
    await running;
  });
});
