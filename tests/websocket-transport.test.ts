import { describe, expect, test } from "bun:test";

import { readSamples } from "../src/audio/pcm.ts";
import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { type Frame } from "../src/frames/index.ts";
import { type ClientSocket } from "../src/transports/socket.ts";
import { parseControlMessage, WebSocketTransport } from "../src/transports/websocket-transport.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** A socket that records everything written to it. */
class FakeSocket implements ClientSocket {
  readonly sent: (Uint8Array | string)[] = [];

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {}

  /** The samples of each audio message, decoded. */
  get audio(): Int16Array[] {
    return this.sent
      .filter((data): data is Uint8Array => typeof data !== "string")
      .map((bytes) => readSamples(bytes, bytes.length));
  }
}

/** Records every frame it sees and forwards it. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
    this.push(frame);
  }
}

/** Little-endian bytes for a run of samples, as a client would send them. */
function bytes(samples: number[]): Uint8Array {
  const buffer = new Uint8Array(samples.length * 2);
  const view = new DataView(buffer.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return buffer;
}

/** Waits until a condition holds, so tests do not depend on timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was never met");
}

describe("parseControlMessage", () => {
  test("decodes a known control message", () => {
    expect(parseControlMessage('{"type":"llmRun"}')).toEqual({ kind: "llmRun" });
  });

  test("returns nothing for malformed JSON", () => {
    expect(parseControlMessage("{not json")).toBeUndefined();
  });

  test("returns nothing for JSON that is not an object", () => {
    expect(parseControlMessage("42")).toBeUndefined();
    expect(parseControlMessage("null")).toBeUndefined();
    expect(parseControlMessage('"llmRun"')).toBeUndefined();
  });

  test("returns nothing for an unknown type", () => {
    expect(parseControlMessage('{"type":"somethingElse"}')).toBeUndefined();
    expect(parseControlMessage("{}")).toBeUndefined();
  });

  test("ignores extra fields", () => {
    // A client may send more than we read without breaking the session.
    expect(parseControlMessage('{"type":"llmRun","extra":1}')).toEqual({ kind: "llmRun" });
  });
});

describe("WebSocketTransport", () => {
  test("turns client audio into inputAudio frames", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([transport.input, spy]);
    const running = pipeline.start(RATES);

    transport.handleMessage(bytes([100, 200]));
    await until(() => spy.seen.length === 2);

    expect(spy.seen[1]).toMatchObject({ kind: "inputAudio" });

    await pipeline.stop();
    await running;
  });

  test("turns ttsAudio frames into bytes for the client", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket);
    const pipeline = new Pipeline([transport.output]);
    const running = pipeline.start(RATES);

    pipeline.push({ kind: "ttsAudio", data: Int16Array.from([7, 8]), id: 0 });
    await until(() => socket.audio.length > 0);

    expect(socket.audio[0]).toEqual(Int16Array.from([7, 8]));

    await pipeline.stop();
    await running;
  });

  test("injects a control message as a frame", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([transport.input, spy]);
    const running = pipeline.start(RATES);

    transport.handleMessage('{"type":"llmRun"}');
    await until(() => spy.seen.some((frame) => frame.kind === "llmRun"));

    expect(spy.seen.map((frame) => frame.kind)).toContain("llmRun");

    await pipeline.stop();
    await running;
  });

  test("keeps control frames in arrival order with audio", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([transport.input, spy]);
    const running = pipeline.start(RATES);
    await until(() => transport.input.sessionRate !== undefined);

    // The control frame is queued where it arrived rather than pushed past the
    // audio, so it must not overtake it.
    transport.handleMessage(bytes([1]));
    transport.handleMessage('{"type":"llmRun"}');
    transport.handleMessage(bytes([2]));
    await until(() => spy.seen.length === 4);

    expect(spy.seen.slice(1).map((frame) => frame.kind)).toEqual([
      "inputAudio",
      "llmRun",
      "inputAudio",
    ]);

    await pipeline.stop();
    await running;
  });

  test("ignores a control message it does not understand", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket);
    const spy = new Spy("spy");
    const pipeline = new Pipeline([transport.input, spy]);
    const running = pipeline.start(RATES);

    transport.handleMessage("{not json");
    transport.handleMessage(bytes([5]));
    await until(() => spy.seen.length === 2);

    // Only the audio frame was injected; the malformed message produced none.
    expect(spy.seen[1]).toMatchObject({ kind: "inputAudio" });

    await pipeline.stop();
    await running;
  });

  test("uses the client rates it was given", async () => {
    const socket = new FakeSocket();
    // The client sends 8k and expects 48k, so both directions convert.
    const transport = new WebSocketTransport(socket, {
      clientSampleRateIn: 8000,
      clientSampleRateOut: 48000,
    });
    const spy = new Spy("spy");
    const pipeline = new Pipeline([transport.input, spy, transport.output]);
    const running = pipeline.start(RATES);
    await until(() => transport.input.sessionRate !== undefined);

    transport.handleMessage(bytes([0, 100]));
    await until(() => spy.seen.length === 2);
    // 8k up to 16k doubles, inserting a midpoint.
    expect(spy.seen[1]).toMatchObject({ kind: "inputAudio" });
    expect((spy.seen[1] as { data: Int16Array }).data).toEqual(
      Int16Array.from([0, 50, 100]),
    );

    await pipeline.stop();
    await running;
  });

  test("announces a connection and a disconnect", async () => {
    const socket = new FakeSocket();
    const events: string[] = [];
    const transport = new WebSocketTransport(socket, {
      onClientConnected: () => events.push("connected"),
      onClientDisconnected: () => events.push("disconnected"),
    });
    const pipeline = new Pipeline([transport.input]);
    const running = pipeline.start(RATES);

    transport.handleConnected();
    await until(() => events.length === 1);

    transport.handleDisconnect();
    await running;

    expect(events).toEqual(["connected", "disconnected"]);
  });

  test("ignores a control message that arrives after the connection closed", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket);
    const pipeline = new Pipeline([transport.input]);
    const running = pipeline.start(RATES);

    transport.handleDisconnect();
    await running;

    // The queue is closed, so this must not throw.
    expect(() => transport.handleMessage('{"type":"llmRun"}')).not.toThrow();
  });
});
