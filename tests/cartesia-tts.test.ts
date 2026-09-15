import { afterAll, describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { writeSamples } from "../src/audio/pcm.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import {
  CARTESIA_URL,
  CARTESIA_VERSION,
  CartesiaTTS,
  cartesiaUrl,
  readChunkData,
  readContextId,
  readError,
} from "../src/services/cartesia-tts.ts";

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

  /** Every audio frame's samples, in order. */
  get audio(): Int16Array[] {
    return this.seen
      .filter((frame) => frame.kind === "ttsAudio")
      .map((frame) => (frame as { data: Int16Array }).data);
  }
}

/** Waits until a condition holds, so tests do not depend on timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

/**
 * Await a promise that is expected to reject, giving up after a while.
 *
 * The race matters: a service that fails to report a problem leaves the
 * pipeline running forever, and `expect(...).rejects` does not time out, so
 * the suite would hang instead of failing. A regression has to fail loudly.
 *
 * @param promise The promise expected to reject.
 * @param ms How long to wait before calling it a hang.
 * @returns The rejection reason.
 */
async function rejection(promise: Promise<unknown>, ms = 5000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("pipeline did not settle in time")), ms);
  });

  try {
    return await Promise.race([
      promise.then(
        () => {
          throw new Error("expected the pipeline to fail, but it stopped normally");
        },
        (error: unknown) => error,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Base64 of little-endian 16-bit samples, as Cartesia sends them. */
function encode(samples: number[]): string {
  return Buffer.from(writeSamples(Int16Array.from(samples))).toString("base64");
}

describe("cartesiaUrl", () => {
  test("carries the API version", () => {
    // Cartesia requires it and uses it to pick the protocol the socket speaks.
    const url = new URL(cartesiaUrl({ apiKey: "k", voice: "v" }));

    expect(url.searchParams.get("cartesia_version")).toBe(CARTESIA_VERSION);
  });

  test("never puts the API key in the URL", () => {
    // A key in a query string leaks into logs and proxies; it goes in a header.
    const url = cartesiaUrl({ apiKey: "super-secret", voice: "v" });

    expect(url).not.toContain("super-secret");
  });

  test("defaults to the real endpoint", () => {
    expect(CARTESIA_URL).toBe("wss://api.cartesia.ai/tts/websocket");
  });
});

describe("readChunkData", () => {
  test("decodes a chunk to samples", () => {
    const message = { type: "chunk", data: encode([258, -1, 1000]) };

    expect(readChunkData(message)).toEqual(Int16Array.from([258, -1, 1000]));
  });

  test("reads the samples as little-endian", () => {
    // The wire format is defined once, in pcm.ts; getting the order wrong here
    // would turn every sample into noise.
    const message = { type: "chunk", data: Buffer.from([0x02, 0x01, 0xff, 0xff]).toString("base64") };

    expect(readChunkData(message)).toEqual(Int16Array.from([258, -1]));
  });

  test("ignores message types that carry no audio", () => {
    expect(readChunkData({ type: "done", data: encode([1]) })).toBeUndefined();
    expect(readChunkData({ type: "flush_done" })).toBeUndefined();
    expect(readChunkData({ type: "timestamps" })).toBeUndefined();
  });

  test("ignores malformed messages rather than throwing", () => {
    // The payload comes from the network, so nothing about its shape is safe
    // to assume.
    expect(readChunkData(null)).toBeUndefined();
    expect(readChunkData("a string")).toBeUndefined();
    expect(readChunkData({ type: "chunk" })).toBeUndefined();
    expect(readChunkData({ type: "chunk", data: "" })).toBeUndefined();
    expect(readChunkData({ type: "chunk", data: "!!!not base64!!!" })).toBeUndefined();
  });
});

describe("readContextId", () => {
  test("reads the context a message belongs to", () => {
    expect(readContextId({ type: "chunk", context_id: "abc" })).toBe("abc");
  });

  test("ignores messages with no context", () => {
    expect(readContextId({ type: "chunk" })).toBeUndefined();
    expect(readContextId(null)).toBeUndefined();
  });
});

describe("readError", () => {
  test("reads an error with its detail", () => {
    const error = readError({
      type: "error",
      title: "Invalid model",
      message: "The model is not valid.",
    });

    expect(error?.message).toBe("Invalid model: The model is not valid.");
  });

  test("reads an error with no detail", () => {
    expect(readError({ type: "error", title: "Invalid model" })?.message).toBe("Invalid model");
  });

  test("ignores messages that are not errors", () => {
    expect(readError({ type: "chunk", data: "x" })).toBeUndefined();
    expect(readError(null)).toBeUndefined();
  });
});

/** A fake Cartesia, so the wire protocol is exercised without an API key. */
class FakeCartesia {
  readonly #server: Bun.Server<undefined>;
  /** The API key header each connection presented. */
  readonly apiKeys: (string | null)[] = [];
  /** The version each connection requested. */
  readonly versions: (string | null)[] = [];
  /** Generation requests received, parsed. */
  readonly requests: Record<string, unknown>[] = [];
  /** Cancellation requests received, parsed. */
  readonly cancels: Record<string, unknown>[] = [];
  #socket: Bun.ServerWebSocket<undefined> | undefined;

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        this.apiKeys.push(request.headers.get("x-api-key"));
        this.versions.push(url.searchParams.get("cartesia_version"));
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("expected a WebSocket", { status: 426 });
      },
      websocket: {
        open: (socket) => {
          this.#socket = socket;
        },
        message: (_socket, message) => {
          if (typeof message !== "string") {
            return;
          }
          const parsed = JSON.parse(message) as Record<string, unknown>;
          if (parsed.cancel === true) {
            this.cancels.push(parsed);
          } else {
            this.requests.push(parsed);
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://localhost:${this.#server.port}/tts/websocket`;
  }

  /** The context id of the most recent generation request. */
  get lastContextId(): string {
    return this.requests[this.requests.length - 1]!.context_id as string;
  }

  /** Send an audio chunk for a context, as Cartesia would. */
  chunk(contextId: string, samples: number[]): void {
    this.#socket?.send(JSON.stringify({ type: "chunk", data: encode(samples), context_id: contextId }));
  }

  /** Send the completion signal for a context. */
  done(contextId: string): void {
    this.#socket?.send(JSON.stringify({ type: "done", done: true, context_id: contextId }));
  }

  /** Send an error for a context, or globally when none is given. */
  error(message: unknown): void {
    this.#socket?.send(JSON.stringify(message));
  }

  /** Send a payload that is not JSON at all. */
  sendRaw(payload: string): void {
    this.#socket?.send(payload);
  }

  stop(): void {
    this.#server.stop(true);
  }
}

describe("CartesiaTTS", () => {
  const servers: FakeCartesia[] = [];

  function fakeCartesia(): FakeCartesia {
    const server = new FakeCartesia();
    servers.push(server);
    return server;
  }

  afterAll(() => {
    for (const server of servers) {
      server.stop();
    }
  });

  test("connects with the key in a header and the version in the query", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "secret-key", voice: "v", url: cartesia.url });
    const pipeline = new Pipeline([tts]);
    const running = pipeline.start(RATES);

    await until(() => cartesia.apiKeys.length === 1);

    expect(cartesia.apiKeys[0]).toBe("secret-key");
    expect(cartesia.versions[0]).toBe(CARTESIA_VERSION);

    await pipeline.stop();
    await running;
  });

  test("asks for the format a pipeline carries, at the session rate", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const pipeline = new Pipeline([tts]);
    // Deliberately not the usual 24000: a rate that happens to equal a value
    // the service might hardcode would let that mistake pass unnoticed.
    const running = pipeline.start({ sampleRateIn: 16000, sampleRateOut: 8000 });
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hello." }));
    await until(() => cartesia.requests.length === 1);

    // pcm_s16le is little-endian 16-bit mono, which is exactly what a pipeline
    // carries, so no conversion is needed on the way back. The rate is the
    // session's, so the audio comes back at the rate the output expects.
    expect(cartesia.requests[0]!.output_format).toEqual({
      container: "raw",
      encoding: "pcm_s16le",
      sample_rate: 8000,
    });

    await pipeline.stop();
    await running;
  });

  test("sends the voice, model, and language", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({
      apiKey: "k",
      voice: "voice-id",
      model: "sonic-3.6",
      language: "zh",
      url: cartesia.url,
    });
    const pipeline = new Pipeline([tts]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "你好。" }));
    await until(() => cartesia.requests.length === 1);

    expect(cartesia.requests[0]!.voice).toBe("voice-id");
    expect(cartesia.requests[0]!.model_id).toBe("sonic-3.6");
    expect(cartesia.requests[0]!.language).toBe("zh");
    expect(cartesia.requests[0]!.transcript).toBe("你好。");

    await pipeline.stop();
    await running;
  });

  test("closes the context so Cartesia finishes the sentence", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const pipeline = new Pipeline([tts]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hello." }));
    await until(() => cartesia.requests.length === 1);

    // Each sentence is its own context, closed at once: that is what tells
    // Cartesia the sentence is complete rather than awaiting more input.
    expect(cartesia.requests[0]!.continue).toBe(false);
    expect(typeof cartesia.requests[0]!.context_id).toBe("string");

    await pipeline.stop();
    await running;
  });

  test("turns audio chunks into ttsAudio frames", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);

    cartesia.chunk(cartesia.lastContextId, [258, -1]);
    cartesia.chunk(cartesia.lastContextId, [1000]);
    await until(() => spy.audio.length === 2);

    expect(spy.audio[0]).toEqual(Int16Array.from([258, -1]));
    expect(spy.audio[1]).toEqual(Int16Array.from([1000]));

    await pipeline.stop();
    await running;
  });

  test("reports the bot speaking once, then stopped", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);

    // Several chunks are one utterance, so the start is reported once.
    cartesia.chunk(cartesia.lastContextId, [1]);
    cartesia.chunk(cartesia.lastContextId, [2]);
    cartesia.done(cartesia.lastContextId);
    await until(() => spy.kinds.includes("botStoppedSpeaking"));

    expect(spy.kinds.filter((kind) => kind === "botStartedSpeaking")).toHaveLength(1);
    expect(spy.kinds.filter((kind) => kind === "botStoppedSpeaking")).toHaveLength(1);

    await pipeline.stop();
    await running;
  });

  test("keeps speaking across sentences, stopping only after the last", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "One." }));
    await until(() => cartesia.requests.length === 1);
    const first = cartesia.lastContextId;

    pipeline.push(createFrame({ kind: "ttsText", text: "Two." }));
    await until(() => cartesia.requests.length === 2);
    const second = cartesia.lastContextId;

    // The first sentence finishing must not read as the reply being over: the
    // second is still coming.
    cartesia.chunk(first, [1]);
    cartesia.done(first);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy.kinds).not.toContain("botStoppedSpeaking");

    cartesia.chunk(second, [2]);
    cartesia.done(second);
    await until(() => spy.kinds.includes("botStoppedSpeaking"));

    expect(spy.kinds.filter((kind) => kind === "botStartedSpeaking")).toHaveLength(1);
    expect(spy.kinds.filter((kind) => kind === "botStoppedSpeaking")).toHaveLength(1);

    await pipeline.stop();
    await running;
  });

  test("consumes the text it synthesises", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // It is an instruction to this service; nothing downstream speaks text.
    expect(spy.kinds).not.toContain("ttsText");

    await pipeline.stop();
    await running;
  });

  test("forwards frames it does not handle", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "llmTextEnded" }));
    await until(() => spy.kinds.includes("llmTextEnded"));

    expect(spy.kinds).toContain("llmTextEnded");

    await pipeline.stop();
    await running;
  });

  test("ignores a chunk for a context it is not tracking", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);

    cartesia.chunk("some-other-context", [1]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A context this service never opened is not its audio to play.
    expect(spy.audio).toHaveLength(0);

    await pipeline.stop();
    await running;
  });

  test("cancels the sentences in flight when the user interrupts", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "A long sentence." }));
    await until(() => cartesia.requests.length === 1);
    const contextId = cartesia.lastContextId;

    cartesia.chunk(contextId, [1]);
    await until(() => spy.audio.length === 1);

    pipeline.interrupt();
    await until(() => cartesia.cancels.length === 1);

    expect(cartesia.cancels[0]).toEqual({ context_id: contextId, cancel: true });

    await pipeline.stop();
    await running;
  });

  test("drops audio still in flight after an interruption", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "A long sentence." }));
    await until(() => cartesia.requests.length === 1);
    const contextId = cartesia.lastContextId;

    pipeline.interrupt();

    // Cartesia has not seen the cancellation yet, so a chunk for the old
    // sentence can still arrive. Playing it would speak over the user's first
    // words.
    cartesia.chunk(contextId, [1, 2, 3]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.audio).toHaveLength(0);

    await pipeline.stop();
    await running;
  });

  test("reports the bot stopped when interrupted mid-sentence", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "A long sentence." }));
    await until(() => cartesia.requests.length === 1);

    cartesia.chunk(cartesia.lastContextId, [1]);
    await until(() => spy.kinds.includes("botStartedSpeaking"));

    // The cancelled context will never report `done`, so without this the
    // pipeline would believe the bot is still speaking.
    pipeline.interrupt();
    await until(() => spy.kinds.includes("botStoppedSpeaking"));

    expect(spy.kinds).toContain("botStoppedSpeaking");

    await pipeline.stop();
    await running;
  });

  test("survives a message that is not JSON", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([tts, spy]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);

    // A payload that is not JSON must be ignored rather than crash the socket
    // handler, and the next real chunk must still get through.
    cartesia.sendRaw("not json at all {");
    cartesia.chunk(cartesia.lastContextId, [7]);
    await until(() => spy.audio.length === 1);

    expect(spy.audio[0]).toEqual(Int16Array.from([7]));

    await pipeline.stop();
    await running;
  });

  test("stops the pipeline when Cartesia reports an error", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const pipeline = new Pipeline([tts]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);

    // A rejected request comes back over the open socket rather than failing
    // the connection, so this is the only way it is noticed.
    cartesia.error({
      type: "error",
      title: "Invalid model",
      message: "The model is not valid.",
      context_id: cartesia.lastContextId,
    });

    const error = await rejection(running);
    expect((error as Error).message).toBe("Invalid model: The model is not valid.");
  });

  test("ignores an error for a context it already cancelled", async () => {
    const cartesia = fakeCartesia();
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: cartesia.url });
    const pipeline = new Pipeline([tts]);
    const running = pipeline.start(RATES);
    await until(() => cartesia.apiKeys.length === 1);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));
    await until(() => cartesia.requests.length === 1);
    const contextId = cartesia.lastContextId;

    pipeline.interrupt();

    // A cancelled context reports an error as it winds down, which is expected
    // rather than a failure.
    cartesia.error({ type: "error", title: "Cancelled", context_id: contextId });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pipeline.isRunning).toBe(true);

    await pipeline.stop();
    await running;
  });

  test("reports a connection failure by stopping the pipeline", async () => {
    // Nothing is listening on this port.
    const tts = new CartesiaTTS({ apiKey: "k", voice: "v", url: "ws://localhost:1/tts/websocket" });
    const pipeline = new Pipeline([tts]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "ttsText", text: "Hi." }));

    await expect(running).rejects.toThrow("could not connect to Cartesia");
  });
});
