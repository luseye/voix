import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { type Frame } from "../src/frames/index.ts";
import { WebSocketInput } from "../src/transports/websocket-input.ts";

/** Records every frame it sees and forwards it downstream. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
    this.push(frame);
  }

  /** The audio payloads seen, in order. */
  get audio(): Int16Array[] {
    return this.seen
      .filter((frame) => frame.kind === "inputAudio")
      .map((frame) => (frame as { data: Int16Array }).data);
  }
}

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

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

describe("WebSocketInput", () => {
  describe("construction", () => {
    test("rejects a non-positive or fractional rate", () => {
      expect(() => new WebSocketInput(0)).toThrow("positive integer");
      expect(() => new WebSocketInput(-1)).toThrow("positive integer");
      expect(() => new WebSocketInput(16000.5)).toThrow("positive integer");
    });

    test("defaults the name to the class name", () => {
      expect(new WebSocketInput(16000).name).toBe("WebSocketInput");
      expect(new WebSocketInput(16000, "custom").name).toBe("custom");
    });
  });

  describe("audio", () => {
    test("turns client bytes into an inputAudio frame at the session rate", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);

      input.handleAudio(bytes([100, 200, 300, 400]));
      await until(() => spy.audio.length > 0);

      // The client rate matches the session rate, so no resampling happens.
      expect(spy.audio[0]).toEqual(Int16Array.from([100, 200, 300, 400]));

      await pipeline.stop();
      await running;
    });

    test("resamples when the client rate differs from the session rate", async () => {
      const input = new WebSocketInput(8000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);

      input.handleAudio(bytes([0, 100, 200, 300]));
      await until(() => spy.audio.length > 0);

      // Doubling 8k to 16k inserts a midpoint between each pair.
      expect(spy.audio[0]).toEqual(Int16Array.from([0, 50, 100, 150, 200, 250, 300]));

      await pipeline.stop();
      await running;
    });

    test("reads samples in little-endian order", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);

      // 0x0102 is 258 little-endian, but 513 big-endian, so this distinguishes
      // a stated byte order from one inherited from the platform.
      input.handleAudio(new Uint8Array([0x02, 0x01]));
      await until(() => spy.audio.length > 0);

      expect(spy.audio[0]).toEqual(Int16Array.from([258]));

      await pipeline.stop();
      await running;
    });

    test("holds bytes that arrive before the start frame", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");

      // Nothing is running yet, so the rate is unknown and the bytes wait.
      input.handleAudio(bytes([100, 200]));
      expect(input.sessionRate).toBeUndefined();

      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      await until(() => spy.audio.length > 0);

      // The held bytes were converted once the start frame supplied the rate.
      expect(spy.audio[0]).toEqual(Int16Array.from([100, 200]));
      expect(input.sessionRate).toBe(16000);

      await pipeline.stop();
      await running;
    });

    test("reassembles a sample split across two messages", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      // Past the start frame, so each message takes the mid-stream path.
      await until(() => input.sessionRate !== undefined);

      // A sample's two bytes arrive in separate messages. The first has no
      // complete sample in it, so the two must be joined rather than read
      // apart: one frame of one sample, not two frames of a stray byte.
      input.handleAudio(new Uint8Array([0x02]));
      input.handleAudio(new Uint8Array([0x01]));
      await until(() => spy.audio.length > 0);

      expect(spy.audio).toHaveLength(1);
      expect(spy.audio[0]).toEqual(Int16Array.from([258]));

      await pipeline.stop();
      await running;
    });

    test("keeps a trailing odd byte for the next message", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      await until(() => input.sessionRate !== undefined);

      // Three bytes: one complete sample and half of the next. Dropping the
      // remainder would shift every later sample by a byte.
      input.handleAudio(new Uint8Array([0x01, 0x00, 0x03]));
      await until(() => spy.audio.length === 1);
      expect(spy.audio[0]).toEqual(Int16Array.from([1]));

      input.handleAudio(new Uint8Array([0x00]));
      await until(() => spy.audio.length === 2);
      expect(spy.audio[1]).toEqual(Int16Array.from([3]));

      await pipeline.stop();
      await running;
    });

    test("carries the resampler across messages", async () => {
      const input = new WebSocketInput(8000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      // Past the start frame, so each message is converted on its own.
      await until(() => input.sessionRate !== undefined);

      // Splitting the stream must not change the samples produced, which is
      // only true while the resampler keeps its state between messages. The
      // second message starts by interpolating towards its first sample, so
      // the boundary between the two is only right if state carried over.
      input.handleAudio(bytes([0, 100]));
      await until(() => spy.audio.length === 1);
      input.handleAudio(bytes([200, 300]));
      await until(() => spy.audio.length === 2);

      expect(spy.audio[0]).toEqual(Int16Array.from([0, 50, 100]));
      expect(spy.audio[1]).toEqual(Int16Array.from([150, 200, 250, 300]));

      await pipeline.stop();
      await running;
    });

    test("does not emit a frame for an empty message", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      await until(() => input.sessionRate !== undefined);

      input.handleAudio(new Uint8Array(0));
      input.handleAudio(bytes([1, 2]));
      await until(() => spy.audio.length > 0);

      expect(spy.audio).toHaveLength(1);

      await pipeline.stop();
      await running;
    });

    test("holds back a message too short to yield an output sample", async () => {
      // A step of three means a message can be too short to contain the input
      // a further output sample needs, so nothing may be emitted for it.
      const input = new WebSocketInput(48000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      await until(() => input.sessionRate !== undefined);

      input.handleAudio(bytes([10]));
      await until(() => spy.audio.length === 1);

      // Two more samples still fall short of the next output position, so this
      // message produces nothing rather than an empty frame.
      input.handleAudio(bytes([20, 30]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spy.audio).toHaveLength(1);

      input.handleAudio(bytes([40, 50, 60, 70]));
      await until(() => spy.audio.length === 2);

      expect(spy.audio[0]).toEqual(Int16Array.from([10]));
      expect(spy.audio[1]).toEqual(Int16Array.from([40, 70]));

      await pipeline.stop();
      await running;
    });
  });

  describe("disconnect", () => {
    test("ends the pipeline when the client goes away", async () => {
      const input = new WebSocketInput(16000);
      const spy = new Spy("spy");
      const pipeline = new Pipeline([input, spy]);
      const running = pipeline.start(RATES);
      await until(() => spy.seen.length === 1);

      input.handleDisconnect();

      await running;

      // The end frame reached the later stage, and this stage stopped too.
      expect(spy.seen.map((frame) => frame.kind)).toEqual(["start", "end"]);
      expect(input.isRunning).toBe(false);
    });
  });
});
