import { describe, expect, test } from "bun:test";

import { readSamples } from "../src/audio/pcm.ts";
import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { type Frame } from "../src/frames/index.ts";
import { type ClientSocket } from "../src/transports/socket.ts";
import { WebSocketServer } from "../src/transports/websocket-server.ts";

const CONFIG = { sampleRateIn: 16000, sampleRateOut: 24000 };

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

describe("WebSocketServer", () => {
  test("starts a session for a connection", async () => {
    const server = new WebSocketServer(CONFIG, (transport) => new Pipeline([transport.input]));
    const socket = new FakeSocket();

    server.handleOpen(socket);
    expect(server.sessionCount).toBe(1);

    await server.stopAll();
    expect(server.sessionCount).toBe(0);
  });

  test("carries audio from a connection to its session", async () => {
    let spy: Spy | undefined;
    const server = new WebSocketServer(CONFIG, (transport) => {
      spy = new Spy("spy");
      return new Pipeline([transport.input, spy, transport.output]);
    });
    const socket = new FakeSocket();

    server.handleOpen(socket);
    server.handleMessage(socket, bytes([100, 200]));

    await until(() => spy!.seen.some((frame) => frame.kind === "inputAudio"));

    const audio = spy!.seen.find((frame) => frame.kind === "inputAudio");
    expect((audio as { data: Int16Array }).data).toEqual(Int16Array.from([100, 200]));

    await server.stopAll();
  });

  test("carries audio from a session back to its connection", async () => {
    let captured: Pipeline | undefined;
    const server = new WebSocketServer(CONFIG, (transport) => {
      const pipeline = new Pipeline([transport.input, transport.output]);
      captured = pipeline;
      return pipeline;
    });
    const socket = new FakeSocket();

    server.handleOpen(socket);
    await until(() => captured !== undefined);

    captured!.push({ kind: "ttsAudio", data: Int16Array.from([9, 10]), id: 0 });
    await until(() => socket.audio.length > 0);

    expect(socket.audio[0]).toEqual(Int16Array.from([9, 10]));

    await server.stopAll();
  });

  test("keeps each connection's session separate", async () => {
    // Sessions are built in order, so the first spy belongs to the first
    // connection and the second to the second.
    const spies: Spy[] = [];
    const server = new WebSocketServer(CONFIG, (transport) => {
      const spy = new Spy("spy");
      spies.push(spy);
      return new Pipeline([transport.input, spy, transport.output]);
    });
    const first = new FakeSocket();
    const second = new FakeSocket();

    server.handleOpen(first);
    server.handleOpen(second);
    expect(server.sessionCount).toBe(2);

    server.handleMessage(first, bytes([1]));
    server.handleMessage(second, bytes([2]));
    await until(() => spies.every((spy) => spy.seen.length === 2));

    // Each session saw only its own client's audio.
    const payloads = spies.map((spy) => (spy.seen[1] as { data: Int16Array }).data[0]);
    expect(payloads).toEqual([1, 2]);

    await server.stopAll();
  });

  test("ends a session when its connection closes", async () => {
    const server = new WebSocketServer(CONFIG, (transport) => new Pipeline([transport.input]));
    const socket = new FakeSocket();

    server.handleOpen(socket);
    server.handleClose(socket);
    expect(server.sessionCount).toBe(0);

    // Closing an unknown connection is not an error.
    expect(() => server.handleClose(socket)).not.toThrow();
  });

  test("ignores a message from an unknown connection", async () => {
    const server = new WebSocketServer(CONFIG, (transport) => new Pipeline([transport.input]));
    const socket = new FakeSocket();

    expect(() => server.handleMessage(socket, bytes([1]))).not.toThrow();
  });

  test("stops every session on shutdown", async () => {
    const pipelines: Pipeline[] = [];
    const server = new WebSocketServer(CONFIG, (transport) => {
      const pipeline = new Pipeline([transport.input]);
      pipelines.push(pipeline);
      return pipeline;
    });

    server.handleOpen(new FakeSocket());
    server.handleOpen(new FakeSocket());
    expect(server.sessionCount).toBe(2);
    expect(pipelines.every((pipeline) => pipeline.isRunning)).toBe(true);

    await server.stopAll();

    expect(server.sessionCount).toBe(0);
    // Clearing the map alone would leave the loops running; shutdown has to
    // actually stop them and wait.
    expect(pipelines.every((pipeline) => pipeline.isRunning)).toBe(false);
  });
});
