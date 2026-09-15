import { afterAll, describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import {
  DEEPGRAM_URL,
  DeepgramSTT,
  deepgramUrl,
  readTranscript,
} from "../src/services/deepgram-stt.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Records every frame it sees. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }

  /** The transcripts seen, as `text:final` pairs. */
  get transcripts(): string[] {
    return this.seen
      .filter((frame) => frame.kind === "transcript")
      .map((frame) => {
        const { text, final } = frame as { text: string; final: boolean };
        return `${text}:${final}`;
      });
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

describe("readTranscript", () => {
  test("reads a final result", () => {
    const message = {
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "hello there" }] },
    };

    expect(readTranscript(message)).toEqual({ text: "hello there", final: true });
  });

  test("reads an interim result", () => {
    const message = {
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "hel" }] },
    };

    expect(readTranscript(message)).toEqual({ text: "hel", final: false });
  });

  test("treats a missing is_final as interim", () => {
    // Only an explicit true is final; anything else is still in progress.
    const message = { type: "Results", channel: { alternatives: [{ transcript: "hi" }] } };

    expect(readTranscript(message)).toEqual({ text: "hi", final: false });
  });

  test("ignores a result with an empty transcript", () => {
    // Interim results arrive with nothing recognised yet.
    const message = { type: "Results", is_final: false, channel: { alternatives: [{ transcript: "" }] } };

    expect(readTranscript(message)).toBeUndefined();
  });

  test("ignores message types that are not results", () => {
    expect(readTranscript({ type: "Metadata" })).toBeUndefined();
    expect(readTranscript({ type: "SpeechStarted" })).toBeUndefined();
    expect(readTranscript({ type: "UtteranceEnd" })).toBeUndefined();
  });

  test("ignores malformed messages rather than throwing", () => {
    // The payload comes from the network, so nothing about its shape is safe
    // to assume.
    expect(readTranscript(null)).toBeUndefined();
    expect(readTranscript("a string")).toBeUndefined();
    expect(readTranscript({ type: "Results" })).toBeUndefined();
    expect(readTranscript({ type: "Results", channel: {} })).toBeUndefined();
    expect(readTranscript({ type: "Results", channel: { alternatives: [] } })).toBeUndefined();
    expect(readTranscript({ type: "Results", channel: { alternatives: [{}] } })).toBeUndefined();
  });
});

describe("deepgramUrl", () => {
  test("asks for the format a pipeline carries", () => {
    const url = new URL(deepgramUrl({ apiKey: "k" }, 16000));

    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
  });

  test("asks for interim results", () => {
    // Without this, nothing is reported until the utterance ends, so a reply
    // could not begin before the user had stopped talking.
    const url = new URL(deepgramUrl({ apiKey: "k" }, 16000));

    expect(url.searchParams.get("interim_results")).toBe("true");
  });

  test("uses the default model and language", () => {
    const url = new URL(deepgramUrl({ apiKey: "k" }, 16000));

    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("language")).toBe("en");
  });

  test("lets the model and language be overridden", () => {
    const url = new URL(deepgramUrl({ apiKey: "k", model: "nova-2", language: "zh" }, 16000));

    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("language")).toBe("zh");
  });

  test("carries the session rate rather than a fixed one", () => {
    expect(new URL(deepgramUrl({ apiKey: "k" }, 8000)).searchParams.get("sample_rate")).toBe("8000");
  });

  test("never puts the API key in the URL", () => {
    // A key in a query string leaks into logs and proxies; it goes in a header.
    const url = deepgramUrl({ apiKey: "super-secret" }, 16000);

    expect(url).not.toContain("super-secret");
  });

  test("defaults to the real endpoint", () => {
    expect(DEEPGRAM_URL).toBe("wss://api.deepgram.com/v1/listen");
  });
});

/** A fake Deepgram, so the wire protocol is exercised without an API key. */
class FakeDeepgram {
  readonly #server: Bun.Server<undefined>;
  /** The authorization header each connection presented. */
  readonly authHeaders: (string | null)[] = [];
  /** The query each connection used. */
  readonly queries: URLSearchParams[] = [];
  /** Binary payloads received, and control messages. */
  readonly audio: Uint8Array[] = [];
  readonly control: string[] = [];
  #socket: Bun.ServerWebSocket<undefined> | undefined;

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        this.authHeaders.push(request.headers.get("authorization"));
        this.queries.push(url.searchParams);
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
          if (typeof message === "string") {
            this.control.push(message);
          } else {
            // Bun hands binary messages over as a Buffer, which is already a
            // Uint8Array.
            this.audio.push(new Uint8Array(message));
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://localhost:${this.#server.port}/v1/listen`;
  }

  /** Send a message to the connected client, as Deepgram would. */
  send(message: unknown): void {
    this.#socket?.send(JSON.stringify(message));
  }

  /** Send raw bytes, for the case where the payload is not JSON at all. */
  sendRaw(payload: string): void {
    this.#socket?.send(payload);
  }

  stop(): void {
    this.#server.stop(true);
  }
}

describe("DeepgramSTT", () => {
  const servers: FakeDeepgram[] = [];

  function fakeDeepgram(): FakeDeepgram {
    const server = new FakeDeepgram();
    servers.push(server);
    return server;
  }

  afterAll(() => {
    for (const server of servers) {
      server.stop();
    }
  });

  test("connects with the key in a header and the session rate in the query", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "secret-key", url: deepgram.url });
    const pipeline = new Pipeline([stt]);
    const running = pipeline.start(RATES);

    await until(() => deepgram.authHeaders.length === 1);

    expect(deepgram.authHeaders[0]).toBe("Token secret-key");
    expect(deepgram.queries[0]!.get("sample_rate")).toBe("16000");

    await pipeline.stop();
    await running;
  });

  test("sends audio as little-endian bytes", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "k", url: deepgram.url });
    const pipeline = new Pipeline([stt]);
    const running = pipeline.start(RATES);
    await until(() => deepgram.authHeaders.length === 1);

    pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([258, -1]) }));
    await until(() => deepgram.audio.length === 1);

    // 258 is 0x0102 little-endian, and -1 is 0xffff.
    expect(deepgram.audio[0]).toEqual(new Uint8Array([0x02, 0x01, 0xff, 0xff]));

    await pipeline.stop();
    await running;
  });

  test("turns results into transcript frames", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "k", url: deepgram.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([stt, spy]);
    const running = pipeline.start(RATES);
    await until(() => deepgram.authHeaders.length === 1);

    deepgram.send({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "hel" }] },
    });
    deepgram.send({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "hello" }] },
    });
    await until(() => spy.transcripts.length === 2);

    expect(spy.transcripts).toEqual(["hel:false", "hello:true"]);

    await pipeline.stop();
    await running;
  });

  test("ignores messages that carry no transcript", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "k", url: deepgram.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([stt, spy]);
    const running = pipeline.start(RATES);
    await until(() => deepgram.authHeaders.length === 1);

    deepgram.send({ type: "Metadata", request_id: "x" });
    deepgram.send({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "" }] } });
    deepgram.send({ type: "SpeechStarted" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.transcripts).toHaveLength(0);

    await pipeline.stop();
    await running;
  });

  test("survives a message that is not JSON", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "k", url: deepgram.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([stt, spy]);
    const running = pipeline.start(RATES);
    await until(() => deepgram.authHeaders.length === 1);

    // A payload that is not JSON must be ignored rather than crash the socket
    // handler, and the next real result must still get through.
    deepgram.sendRaw("not json at all {");
    deepgram.send({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "ok" }] } });
    await until(() => spy.transcripts.length === 1);

    expect(spy.transcripts).toEqual(["ok:true"]);

    await pipeline.stop();
    await running;
  });

  test("forwards frames it does not handle", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "k", url: deepgram.url });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([stt, spy]);
    const running = pipeline.start(RATES);
    await until(() => deepgram.authHeaders.length === 1);

    pipeline.push(createFrame({ kind: "llmRun" }));
    await until(() => spy.seen.some((frame) => frame.kind === "llmRun"));

    expect(spy.seen.map((frame) => frame.kind)).toContain("llmRun");

    await pipeline.stop();
    await running;
  });

  test("tells Deepgram the stream ended before closing", async () => {
    const deepgram = fakeDeepgram();
    const stt = new DeepgramSTT({ apiKey: "k", url: deepgram.url });
    const pipeline = new Pipeline([stt]);
    const running = pipeline.start(RATES);
    await until(() => deepgram.authHeaders.length === 1);

    // An audio round trip proves the connection is established. Stopping any
    // earlier would abort a handshake that never opened, and there is nothing
    // to tell Deepgram to finalize in that case.
    pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([1]) }));
    await until(() => deepgram.audio.length === 1);

    await pipeline.stop();
    await running;

    // The control message travels over the socket, so it is not there the
    // instant the client sends it.
    await until(() => deepgram.control.length > 0);

    // Closing without CloseStream would drop audio Deepgram had already
    // received but not yet transcribed.
    expect(deepgram.control).toContain(JSON.stringify({ type: "CloseStream" }));
  });

  test("reports a connection failure by stopping the pipeline", async () => {
    // Nothing is listening on this port.
    const stt = new DeepgramSTT({ apiKey: "k", url: "ws://localhost:1/v1/listen" });
    const pipeline = new Pipeline([stt]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([1]) }));

    await expect(running).rejects.toThrow("could not connect to Deepgram");
  });
});
