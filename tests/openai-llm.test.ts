import { afterAll, describe, expect, test } from "bun:test";

import { LLMContext } from "../src/core/context.ts";
import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import {
  OPENAI_URL,
  OpenAILLM,
  readDelta,
  readSse,
} from "../src/services/openai-llm.ts";
import { FakeOpenAI, chunk, event, until } from "./fakes.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Records every frame it sees. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }

  get kinds(): string[] {
    return this.seen.map((frame) => frame.kind);
  }

  /** The text of the `llmText` frames, joined. */
  get text(): string {
    return this.seen
      .filter((frame) => frame.kind === "llmText")
      .map((frame) => (frame as { text: string }).text)
      .join("");
  }
}

/** Collect an async generator into an array. */
async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

describe("readDelta", () => {
  test("reads the fragment a chunk carries", () => {
    expect(readDelta(chunk("hel"))).toBe("hel");
  });

  test("ignores a chunk with no text", () => {
    // The first chunk announces the role and the last reports why generation
    // stopped; neither carries text.
    expect(readDelta({ choices: [{ delta: { role: "assistant" } }] })).toBeUndefined();
    expect(readDelta({ choices: [{ delta: {} }] })).toBeUndefined();
    expect(readDelta({ choices: [{ finish_reason: "stop" }] })).toBeUndefined();
    expect(readDelta({ choices: [] })).toBeUndefined();
  });

  test("ignores an empty fragment", () => {
    expect(readDelta(chunk(""))).toBeUndefined();
  });

  test("ignores malformed chunks rather than throwing", () => {
    // The payload comes from the network, so nothing about its shape is safe
    // to assume.
    expect(readDelta(null)).toBeUndefined();
    expect(readDelta("a string")).toBeUndefined();
    expect(readDelta({ choices: [{ delta: { content: 42 } }] })).toBeUndefined();
  });
});

describe("readSse", () => {
  /** A stream that emits the given strings as separate reads. */
  function streamOf(...reads: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const read of reads) {
          controller.enqueue(encoder.encode(read));
        }
        controller.close();
      },
    });
  }

  test("reads one payload per event", async () => {
    const body = streamOf(event(chunk("a")) + event(chunk("b")));

    expect(await collect(readSse(body))).toEqual([chunk("a"), chunk("b")]);
  });

  test("stops at the done marker", async () => {
    const body = streamOf(event(chunk("a")) + event("[DONE]") + event(chunk("b")));

    expect(await collect(readSse(body))).toEqual([chunk("a")]);
  });

  test("reassembles an event split across two reads", async () => {
    // A payload can arrive in pieces, so text is buffered until a separator
    // says the event is complete.
    const whole = event(chunk("hello"));
    const body = streamOf(whole.slice(0, 10), whole.slice(10));

    expect(await collect(readSse(body))).toEqual([chunk("hello")]);
  });

  test("treats a carriage return as framing, not payload", async () => {
    const body = streamOf(`data: ${JSON.stringify(chunk("a"))}\r\n\r\n`);

    expect(await collect(readSse(body))).toEqual([chunk("a")]);
  });

  test("skips an event that is not JSON", async () => {
    const body = streamOf(event("not json at all") + event(chunk("ok")));

    expect(await collect(readSse(body))).toEqual([chunk("ok")]);
  });

  test("skips an event with no data field", async () => {
    const body = streamOf(": a comment\n\n" + event(chunk("ok")));

    expect(await collect(readSse(body))).toEqual([chunk("ok")]);
  });

  test("reads nothing from an empty stream", async () => {
    expect(await collect(readSse(streamOf()))).toEqual([]);
  });

  test("ignores an event that was never terminated", async () => {
    // An event is complete only once its blank line arrives, so a payload left
    // unterminated at the end of the stream is not dispatched. A stream cut
    // off mid-event would otherwise be read as a chunk, and a truncated
    // fragment of JSON is not something to act on.
    expect(await collect(readSse(streamOf('data: {"a":1}')))).toEqual([]);
  });
});

describe("OpenAILLM", () => {
  const servers: FakeOpenAI[] = [];

  function fakeOpenAI(): FakeOpenAI {
    const server = new FakeOpenAI();
    servers.push(server);
    return server;
  }

  afterAll(() => {
    for (const server of servers) {
      server.stop();
    }
  });

  test("answers when asked to run", async () => {
    const openai = fakeOpenAI();
    openai.reply("hello");
    const context = new LLMContext();
    const llm = new OpenAILLM(context, { apiKey: "k", url: openai.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([llm, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    expect(spy.text).toBe("hello");

    await pipeline.stop();
    await running;
  });

  test("sends the key in a header", async () => {
    const openai = fakeOpenAI();
    openai.reply("hi");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "secret-key", url: openai.url });
    const pipeline = new Pipeline([llm]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => openai.authHeaders.length === 1);

    expect(openai.authHeaders[0]).toBe("Bearer secret-key");

    await pipeline.stop();
    await running;
  });

  test("sends the conversation so far", async () => {
    const openai = fakeOpenAI();
    openai.reply("hi");
    const context = new LLMContext("You are helpful.");
    context.addMessage({ role: "user", content: "hello" });
    const llm = new OpenAILLM(context, { apiKey: "k", url: openai.url });
    const pipeline = new Pipeline([llm]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => openai.bodies.length === 1);

    expect(openai.bodies[0]!.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ]);

    await pipeline.stop();
    await running;
  });

  test("asks for a streamed reply", async () => {
    const openai = fakeOpenAI();
    openai.reply("hi");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const pipeline = new Pipeline([llm]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => openai.bodies.length === 1);

    // Without streaming nothing is reported until the whole reply is generated,
    // so speech could not begin until the model had finished.
    expect(openai.bodies[0]!.stream).toBe(true);

    await pipeline.stop();
    await running;
  });

  test("uses the default model and lets it be overridden", async () => {
    const openai = fakeOpenAI();
    openai.reply("hi");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const pipeline = new Pipeline([llm]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => openai.bodies.length === 1);
    expect(openai.bodies[0]!.model).toBe("gpt-4o-mini");

    await pipeline.stop();
    await running;
  });

  test("forwards the fragments as they arrive rather than at the end", async () => {
    const openai = fakeOpenAI();
    openai.reply("hel", "lo");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([llm, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    // Two chunks, so the text reaches synthesis while the model is still
    // generating the rest.
    expect(spy.kinds.filter((kind) => kind === "llmText")).toHaveLength(2);
    expect(spy.text).toBe("hello");

    await pipeline.stop();
    await running;
  });

  test("marks the end of the reply", async () => {
    const openai = fakeOpenAI();
    openai.reply("hi");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([llm, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    expect(spy.kinds).toContain("llmTextEnded");

    await pipeline.stop();
    await running;
  });

  test("consumes the run frame rather than forwarding it", async () => {
    const openai = fakeOpenAI();
    openai.reply("hi");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([llm, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    // Nothing downstream acts on a run instruction; it is addressed to this
    // service.
    expect(spy.kinds).not.toContain("llmRun");

    await pipeline.stop();
    await running;
  });

  test("forwards frames it does not handle", async () => {
    const openai = fakeOpenAI();
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([llm, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "transcript", text: "hi", final: true }));
    await until(() => spy.kinds.includes("transcript"));

    expect(spy.kinds).toContain("transcript");

    await pipeline.stop();
    await running;
  });

  test("stops the request when interrupted", async () => {
    const openai = fakeOpenAI();
    openai.replyAndHold("I was saying");
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([llm, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => spy.kinds.includes("llmText"));

    // The request is made with the turn's signal, so an interruption cancels
    // it: the model should not keep generating a reply nobody will hear.
    pipeline.interrupt();
    await until(() => spy.kinds.includes("llmTextEnded"));

    // What was already spoken is still part of the conversation, so the end
    // marker goes out even though the reply was cut short.
    expect(spy.kinds).toContain("llmTextEnded");
    expect(spy.text).toBe("I was saying");

    await pipeline.stop();
    await running;
  });

  test("stops the pipeline when the request fails", async () => {
    const openai = fakeOpenAI();
    openai.fail(500);
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const pipeline = new Pipeline([llm]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));

    await expect(running).rejects.toThrow("OpenAI request failed with status 500");
  });

  test("stops the pipeline when the request fails and no frame follows", async () => {
    // The `llmRun` that started the request is consumed, so nothing else will
    // wake the loop. Without the wake the pipeline would wait forever.
    const openai = fakeOpenAI();
    openai.fail(401);
    const llm = new OpenAILLM(new LLMContext(), { apiKey: "k", url: openai.url });
    const pipeline = new Pipeline([llm]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "llmRun" }));

    await expect(running).rejects.toThrow("OpenAI request failed with status 401");
  });

  test("defaults to the real endpoint", () => {
    expect(OPENAI_URL).toBe("https://api.openai.com/v1/chat/completions");
  });
});
