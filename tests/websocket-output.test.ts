import { describe, expect, test } from "bun:test";

import { readSamples } from "../src/audio/pcm.ts";
import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import { type ClientSocket } from "../src/transports/socket.ts";
import { WebSocketOutput } from "../src/transports/websocket-output.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** A socket that records everything written to it. */
class FakeSocket implements ClientSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;

  send(data: Uint8Array | string): void {
    if (typeof data === "string") {
      throw new Error("the output transport only sends audio");
    }
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** The samples of each audio message, decoded. */
  get samples(): Int16Array[] {
    return this.sent.map((bytes) => readSamples(bytes, bytes.length));
  }
}

/** Records every frame it sees. */
class Sink extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
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

describe("WebSocketOutput", () => {
  describe("construction", () => {
    test("rejects a non-positive or fractional rate", () => {
      const socket = new FakeSocket();
      expect(() => new WebSocketOutput(socket, 0)).toThrow("positive integer");
      expect(() => new WebSocketOutput(socket, 24000.5)).toThrow("positive integer");
    });
  });

  describe("audio", () => {
    test("resamples session audio to the client's rate", async () => {
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 24000);
      const pipeline = new Pipeline([output]);
      const running = pipeline.start(RATES);

      // The session runs at 24k and the client expects 24k, so no conversion.
      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([1, 2, 3]) }));
      await until(() => socket.sent.length > 0);

      expect(socket.samples[0]).toEqual(Int16Array.from([1, 2, 3]));

      await pipeline.stop();
      await running;
    });

    test("converts when the client's rate differs from the session's", async () => {
      // The client expects 8k, so 24k audio is downsampled by three.
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 8000);
      const pipeline = new Pipeline([output]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([0, 3, 6, 9, 12, 15]) }));
      await until(() => socket.sent.length > 0);

      expect(socket.samples[0]).toEqual(Int16Array.from([0, 9]));

      await pipeline.stop();
      await running;
    });

    test("sends bytes in little-endian order", async () => {
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 24000);
      const pipeline = new Pipeline([output]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([258]) }));
      await until(() => socket.sent.length > 0);

      expect(socket.sent[0]).toEqual(new Uint8Array([0x02, 0x01]));

      await pipeline.stop();
      await running;
    });

    test("carries the resampler across frames", async () => {
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 48000);
      const pipeline = new Pipeline([output]);
      const running = pipeline.start(RATES);

      // A step of a half, so the second frame's first sample interpolates
      // towards its neighbour. A resampler restarted per frame would treat the
      // boundary as the start of the stream and get it wrong.
      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([0, 2]) }));
      await until(() => socket.sent.length === 1);
      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([4, 6]) }));
      await until(() => socket.sent.length === 2);

      expect(socket.samples[0]).toEqual(Int16Array.from([0, 1, 2]));
      expect(socket.samples[1]).toEqual(Int16Array.from([3, 4, 5, 6]));

      await pipeline.stop();
      await running;
    });

    test("sends nothing for a frame that produces no samples", async () => {
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 8000);
      const pipeline = new Pipeline([output]);
      const running = pipeline.start(RATES);

      // A step of three. The first frame's sample lands on an input sample, so
      // it is emitted; the next output position needs a third sample, which
      // this frame does not reach, so nothing is sent for it.
      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([5]) }));
      await until(() => socket.sent.length === 1);
      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([6, 7]) }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(socket.sent).toHaveLength(1);

      await pipeline.stop();
      await running;
    });
  });

  describe("forwarding", () => {
    test("forwards every frame downstream", async () => {
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 24000);
      const sink = new Sink("sink");
      const pipeline = new Pipeline([output, sink]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([1]) }));
      await until(() => sink.seen.length === 2);

      // The audio frame is passed on, not consumed, so a stage placed after
      // the transport still sees it.
      expect(sink.seen.map((frame) => frame.kind)).toEqual(["start", "ttsAudio"]);

      await pipeline.stop();
      await running;
    });

    test("ignores audio that arrives before the start frame", async () => {
      const socket = new FakeSocket();
      const output = new WebSocketOutput(socket, 24000);

      // Nothing is running, so the session rate is unknown. The frame is
      // queued and handled once the pipeline starts.
      output.enqueue(createFrame({ kind: "ttsAudio", data: Int16Array.from([1, 2]) }));

      const pipeline = new Pipeline([output]);
      const running = pipeline.start(RATES);
      await until(() => socket.sent.length > 0);

      expect(socket.samples[0]).toEqual(Int16Array.from([1, 2]));

      await pipeline.stop();
      await running;
    });
  });
});
