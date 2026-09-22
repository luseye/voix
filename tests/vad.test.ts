/**
 * The turn-taking state machine.
 *
 * Everything here runs on a scripted probability source, so the thresholds and
 * the edges they produce are tested exactly — window by window — without a
 * model, a microphone, or timing luck.
 */

import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import {
  START_WINDOWS,
  STOP_WINDOWS,
  VADProcessor,
  type ProbabilitySource,
} from "../src/audio/vad.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** A probability source that answers from a script, one entry per window. */
class ScriptedSource implements ProbabilitySource {
  #next = 0;

  constructor(readonly probabilities: number[]) {}

  async process(samples: Float32Array): Promise<number[]> {
    // One probability per complete window, as the real model reports; the
    // samples themselves are irrelevant to the state machine.
    const windows = Math.floor(samples.length / 512);
    const result: number[] = [];
    for (let i = 0; i < windows; i++) {
      result.push(this.probabilities[this.#next++] ?? 0);
    }
    return result;
  }
}

/** A pipeline with the VAD and a spy, plus the spy itself. */
async function started(probabilities: number[]) {
  const spy = new Spy();
  const vad = new VADProcessor({ source: new ScriptedSource(probabilities) });
  const pipeline = new Pipeline([vad, spy]);
  const running = pipeline.start(RATES);
  return { pipeline, spy, running, vad };
}

/** Records every frame it sees. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }

  /** The speaking-state kinds seen, in order. */
  get edges(): string[] {
    return this.seen
      .map((frame) => frame.kind)
      .filter((kind) => kind === "userStartedSpeaking" || kind === "userStoppedSpeaking");
  }
}

describe("VADProcessor", () => {
  test("reports a start only after sustained speech", async () => {
    // One below the bar: four speech windows, then a silent one. Whatever the
    // cough was, it did not last, so no turn begins.
    const probabilities = [0.9, 0.9, 0.9, 0.9, 0.1];
    const { pipeline, spy, running } = await started(probabilities);

    // One audio frame of 5*512 samples carries the whole script.
    pipeline.push(createFrame({ kind: "inputAudio", data: new Int16Array(START_WINDOWS * 512) }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.edges).toEqual([]);

    await pipeline.stop();
    await running;
  });

  test("reports a start once the speech run reaches the threshold", async () => {
    const { pipeline, spy, running } = await started(new Array(START_WINDOWS).fill(0.9));

    pipeline.push(createFrame({ kind: "inputAudio", data: new Int16Array(START_WINDOWS * 512) }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.edges).toEqual(["userStartedSpeaking"]);

    await pipeline.stop();
    await running;
  });

  test("reports a stop after sustained silence while speaking", async () => {
    const probabilities = [...new Array(START_WINDOWS).fill(0.9), ...new Array(STOP_WINDOWS).fill(0.1)];
    const { pipeline, spy, running } = await started(probabilities);

    pipeline.push(
      createFrame({ kind: "inputAudio", data: new Int16Array((START_WINDOWS + STOP_WINDOWS) * 512) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.edges).toEqual(["userStartedSpeaking", "userStoppedSpeaking"]);

    await pipeline.stop();
    await running;
  });

  test("a pause inside speech does not end the turn", async () => {
    // Speech, a pause one window short of a stop, then speech again: the run
    // resets, and only the one start is ever reported.
    const probabilities = [
      ...new Array(START_WINDOWS).fill(0.9),
      ...new Array(STOP_WINDOWS - 1).fill(0.1),
      ...new Array(START_WINDOWS).fill(0.9),
    ];
    const { pipeline, spy, running } = await started(probabilities);

    pipeline.push(createFrame({ kind: "inputAudio", data: new Int16Array(probabilities.length * 512) }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.edges).toEqual(["userStartedSpeaking"]);

    await pipeline.stop();
    await running;
  });

  test("forwards the audio and every other frame untouched", async () => {
    // One window scores once; five windows in one frame confirm a start.
    const { pipeline, spy, running, vad } = await started(new Array(START_WINDOWS).fill(0.9));

    pipeline.push(createFrame({ kind: "inputAudio", data: new Int16Array(START_WINDOWS * 512) }));
    pipeline.push(createFrame({ kind: "llmRun" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const kinds = spy.seen.map((frame) => frame.kind);
    expect(kinds).toContain("inputAudio");
    expect(kinds).toContain("llmRun");
    expect(vad.isSpeaking).toBe(true);

    await pipeline.stop();
    await running;
  });

  test("splits a turn across audio frames", async () => {
    // The start windows arrive in two frames: the state carries between them.
    const { pipeline, spy, running } = await started(new Array(START_WINDOWS).fill(0.9));

    pipeline.push(createFrame({ kind: "inputAudio", data: new Int16Array(2 * 512) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy.edges).toEqual([]);

    pipeline.push(createFrame({ kind: "inputAudio", data: new Int16Array(3 * 512) }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.edges).toEqual(["userStartedSpeaking"]);

    await pipeline.stop();
    await running;
  });
});
