/**
 * Reply-latency measurement.
 *
 * The clock is the only impurity, and every test asserts on gaps it has room
 * for: a measured delay of at least the sleep it waited through, and the
 * absence of a measurement where none should be.
 */

import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { LatencyObserver } from "../src/core/latency-observer.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Waits long enough for a gap the assertions can be generous about. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LatencyObserver", () => {
  test("measures from the stop of speech to the first audio", async () => {
    const observer = new LatencyObserver({}, "latency");
    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await pause(40);
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    const samples = observer.samples;
    expect(samples).toHaveLength(1);
    // At least the pause, since the clock only runs one way.
    expect(samples[0]!.ms).toBeGreaterThanOrEqual(40);

    await pipeline.stop();
    await running;
  });

  test("measures only the first audio chunk of a reply", async () => {
    const observer = new LatencyObserver({}, "latency");
    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await pause(40);
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    expect(observer.samples).toHaveLength(1);

    await pipeline.stop();
    await running;
  });

  test("measures each turn separately", async () => {
    const observer = new LatencyObserver({}, "latency");
    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await pause(30);
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await pause(50);
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    const samples = observer.samples;
    expect(samples).toHaveLength(2);
    // Turn order is preserved, and the second gap was waited longer.
    expect(samples[1]!.ms).toBeGreaterThanOrEqual(samples[0]!.ms);
    expect(samples[1]!.ms).toBeGreaterThanOrEqual(50);

    await pipeline.stop();
    await running;
  });

  test("an interruption cancels the pending measurement", async () => {
    const observer = new LatencyObserver({}, "latency");
    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    // The user talks over the reply before any audio arrives: no audio was
    // heard, so there is no latency to report.
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    expect(observer.samples).toHaveLength(0);

    await pipeline.stop();
    await running;
  });

  test("audio with no stop of speech before it measures nothing", async () => {
    const observer = new LatencyObserver({}, "latency");
    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    expect(observer.samples).toHaveLength(0);

    await pipeline.stop();
    await running;
  });

  test("forwards every frame untouched", async () => {
    const seen: Frame[] = [];

    class Spy extends FrameProcessor {
      protected override async process(frame: Frame): Promise<void> {
        seen.push(frame);
      }
    }

    const spy = new Spy("spy");
    const observer = new LatencyObserver({}, "latency");
    const pipeline = new Pipeline([observer, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    pipeline.push(createFrame({ kind: "llmText", text: "hi" }));
    await pause(20);

    const kinds = seen.map((frame) => frame.kind);
    expect(kinds).toContain("userStoppedSpeaking");
    expect(kinds).toContain("ttsAudio");
    expect(kinds).toContain("llmText");

    await pipeline.stop();
    await running;
  });

  test("the report summarises the samples", async () => {
    const observer = new LatencyObserver({}, "latency");
    expect(observer.report).toBeUndefined();

    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await pause(30);
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    const report = observer.report;
    expect(report).toBeDefined();
    expect(report!.count).toBe(1);
    expect(report!.avg).toBeCloseTo(report!.min);
    expect(report!.max).toBeGreaterThanOrEqual(report!.min);

    await pipeline.stop();
    await running;
  });

  test("calls back as each measurement completes", async () => {
    const reported: number[] = [];
    const observer = new LatencyObserver({ onSample: (sample) => reported.push(sample.ms) }, "latency");
    const pipeline = new Pipeline([observer]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
    await pause(30);
    pipeline.push(createFrame({ kind: "ttsAudio", data: new Int16Array(1) }));
    await pause(20);

    expect(reported).toHaveLength(1);
    expect(reported[0]!).toBeGreaterThanOrEqual(30);

    await pipeline.stop();
    await running;
  });
});
