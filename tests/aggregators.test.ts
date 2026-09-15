import { describe, expect, test } from "bun:test";

import { AssistantAggregator, UserAggregator } from "../src/core/aggregators.ts";
import { LLMContext } from "../src/core/context.ts";
import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Records every frame it sees. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
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

describe("UserAggregator", () => {
  test("records what the user said when they stop speaking", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "transcript", text: "hello there", final: true }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await until(() => context.length === 1);

    expect(context.getMessages()).toEqual([{ role: "user", content: "hello there" }]);

    await pipeline.stop();
    await running;
  });

  test("joins the final pieces of one utterance into a single message", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    // One utterance can be reported in several final results. Recording each
    // separately would leave the history reading as fragments.
    pipeline.push(createFrame({ kind: "transcript", text: "what is", final: true }));
    pipeline.push(createFrame({ kind: "transcript", text: "the weather", final: true }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await until(() => context.length === 1);

    expect(context.getMessages()).toEqual([{ role: "user", content: "what is the weather" }]);

    await pipeline.stop();
    await running;
  });

  test("ignores interim results", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    // An interim result is a guess that is replaced as it improves, so it is
    // not something the user has actually said yet.
    pipeline.push(createFrame({ kind: "transcript", text: "hel", final: false }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(context.getMessages()).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("starts the model once the user stops speaking", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "transcript", text: "hi", final: true }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await until(() => spy.kinds.includes("llmRun"));

    expect(spy.kinds).toContain("llmRun");

    await pipeline.stop();
    await running;
  });

  test("does not start the model when nothing was said", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    // A pause in a quiet room is not a turn, so there is nothing to reply to.
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spy.kinds).not.toContain("llmRun");
    expect(context.getMessages()).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("does not start the model when the only text was an interim guess", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "transcript", text: "hmm", final: false }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spy.kinds).not.toContain("llmRun");

    await pipeline.stop();
    await running;
  });

  test("starts a fresh utterance after one is recorded", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "transcript", text: "first", final: true }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await until(() => context.length === 1);

    pipeline.push(createFrame({ kind: "transcript", text: "second", final: true }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await until(() => context.length === 2);

    // The pieces of the first utterance must not leak into the second.
    expect(context.getMessages()).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);

    await pipeline.stop();
    await running;
  });

  test("forwards every frame it sees", async () => {
    const context = new LLMContext();
    const aggregator = new UserAggregator(context);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "transcript", text: "hi", final: false }));
    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await until(() => spy.kinds.length >= 2);

    // Even the frames it acts on keep travelling: something downstream may be
    // showing the user their own words. The start frame leads, as always.
    expect(spy.kinds).toEqual(["start", "transcript", "userStoppedSpeaking"]);

    await pipeline.stop();
    await running;
  });
});

describe("AssistantAggregator", () => {
  test("records the reply when the stream ends", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "hello" }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => context.length === 1);

    expect(context.getMessages()).toEqual([{ role: "assistant", content: "hello" }]);

    await pipeline.stop();
    await running;
  });

  test("joins the pieces without a separator", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    // These are fragments of one word, so joining with a space would corrupt
    // it: a model streams "hel" and "lo" meaning "hello".
    pipeline.push(createFrame({ kind: "llmText", text: "hel" }));
    pipeline.push(createFrame({ kind: "llmText", text: "lo" }));
    pipeline.push(createFrame({ kind: "llmText", text: " there" }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => context.length === 1);

    expect(context.getMessages()).toEqual([{ role: "assistant", content: "hello there" }]);

    await pipeline.stop();
    await running;
  });

  test("does not record a reply that was never finished", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    // Until the end marker arrives there is no knowing whether the reply is
    // complete or was cut short.
    pipeline.push(createFrame({ kind: "llmText", text: "partial" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(context.getMessages()).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("does not record an empty reply", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    // A model can emit nothing at all, and an empty assistant message would be
    // a turn that never happened.
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(context.getMessages()).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("starts a fresh reply after one is recorded", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const pipeline = new Pipeline([aggregator]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "first" }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => context.length === 1);

    pipeline.push(createFrame({ kind: "llmText", text: "second" }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => context.length === 2);

    expect(context.getMessages()).toEqual([
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ]);

    await pipeline.stop();
    await running;
  });

  test("forwards the text it collects", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "hi" }));
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    // The text still has to reach speech synthesis; recording it is a side
    // effect, not a replacement for passing it on.
    expect(spy.kinds).toEqual(["start", "llmText", "llmTextEnded"]);

    await pipeline.stop();
    await running;
  });

  test("records the part received when a reply is cut short", async () => {
    const context = new LLMContext();
    const aggregator = new AssistantAggregator(context);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([aggregator, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmText", text: "I was saying" }));
    await until(() => spy.kinds.includes("llmText"));

    // An interruption drops the chunks still queued, but the text already
    // handled is in the reply, and the end marker is not interruptible, so it
    // still arrives to record what the user actually heard.
    pipeline.interrupt();
    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => context.length === 1);

    expect(context.getMessages()).toEqual([{ role: "assistant", content: "I was saying" }]);

    await pipeline.stop();
    await running;
  });
});
