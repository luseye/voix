/**
 * The Silero boundary.
 *
 * Most of this file tests the buffering logic against a fake session, which is
 * what makes it fast and model-free. One test loads the real model, and runs
 * only when the model file is present, so a machine without it still gets full
 * coverage of everything except the model itself.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { SAMPLE_RATE, SileroVAD, WINDOW_SIZE } from "../src/audio/silero.ts";

/** Where the real model is looked for, overridable for local runs. */
const MODEL_PATH = process.env.SILERO_VAD_PATH ?? "/tmp/silero_vad.onnx";

/** A tensor look-alike, since the fake only needs `data`. */
function tensor(data: number[]): { data: Float32Array } {
  return { data: Float32Array.from(data) };
}

/**
 * A session that answers with a scripted probability.
 *
 * It records the windows it was given so a test can assert on them, and hands
 * back whatever probability its script says — one per call, repeating the last
 * entry if the script runs out.
 */
class FakeSession {
  readonly windows: Float32Array[] = [];

  constructor(readonly probabilities: number[]) {}

  async run(inputs: { input: { data: Float32Array } }): Promise<{
    output: { data: Float32Array };
    stateN: unknown;
  }> {
    this.windows.push(inputs.input.data);
    const last = this.probabilities[this.probabilities.length - 1] ?? 0;
    const next = this.probabilities[this.windows.length - 1] ?? last;
    return { output: tensor([next]), stateN: inputs };
  }
}

/** Opens a `SileroVAD` whose model answers from a script. */
async function scripted(probabilities: number[]): Promise<[SileroVAD, FakeSession]> {
  const session = new FakeSession(probabilities);
  const vad = await SileroVAD.create({ modelPath: "fake.onnx" }, session as never);
  return [vad, session];
}

describe("SileroVAD", () => {
  test("reports one probability per complete window", async () => {
    const [vad, session] = await scripted([0.5]);

    // Two and a half windows: only two are complete, so two answers.
    const result = await vad.process(new Float32Array(WINDOW_SIZE * 2 + 256));

    expect(result).toEqual([0.5, 0.5]);
    expect(session.windows.length).toBe(2);
  });

  test("buffers a partial window until it is complete", async () => {
    const [vad, session] = await scripted([0.5]);

    // Neither call holds a whole window on its own: 300 + 212 = 512.
    expect(await vad.process(new Float32Array(300))).toEqual([]);
    const result = await vad.process(new Float32Array(212));

    expect(result).toEqual([0.5]);
    expect(session.windows.length).toBe(1);
    expect(session.windows[0]!.length).toBe(WINDOW_SIZE);
  });

  test("scores nothing until a whole window has arrived", async () => {
    const [vad, session] = await scripted([]);

    expect(await vad.process(new Float32Array(WINDOW_SIZE - 1))).toEqual([]);
    expect(await vad.process(new Float32Array(0))).toEqual([]);
    expect(session.windows.length).toBe(0);
  });

  test("feeds the model the caller's audio, in order", async () => {
    const [vad, session] = await scripted([1]);

    const first = Float32Array.from({ length: WINDOW_SIZE }, (_, i) => i);
    const second = Float32Array.from({ length: WINDOW_SIZE }, (_, i) => -i);
    await vad.process(first);
    await vad.process(second);

    expect(Array.from(session.windows[0]!)).toEqual(Array.from(first));
    expect(Array.from(session.windows[1]!)).toEqual(Array.from(second));
  });

  test("keeps its own leftover when a call leaves part of both buffers", async () => {
    // 300 held, then 412 arrives: 712 in total, one window scored, and the
    // leftover must come from the *joined* stream — 200 samples of held audio.
    // Taking the leftover from the new samples alone would drop that tail and
    // every later window would start at the wrong place.
    //
    // Each sample carries its position in the stream, so the windows the model
    // sees can be checked against where they should start.
    const [vad, session] = await scripted([0.5, 0.5]);

    let position = 0;
    const chunk = (length: number) =>
      Float32Array.from({ length }, () => position++);

    await vad.process(chunk(300));
    await vad.process(chunk(412));
    const result = await vad.process(chunk(312));

    // 200 held + 312 = one more window, covering samples 512..1023 of the
    // stream. Two windows have been scored in total.
    expect(result).toEqual([0.5]);
    expect(session.windows.length).toBe(2);
    // The second window starts where the stream says it should: sample 512.
    expect(session.windows[1]![0]).toBe(512);
  });

  test("carries a sample count, not a window count, across calls", async () => {
    // A caller sends 100 samples, then 412 more: 512 total, one window. An
    // implementation that reset the buffer per call would score nothing at
    // all; one that tracked windows would think a whole window arrived twice.
    const [vad, session] = await scripted([0.25]);

    expect(await vad.process(new Float32Array(100))).toEqual([]);
    expect(await vad.process(new Float32Array(412))).toEqual([0.25]);
    expect(session.windows.length).toBe(1);
  });
});

describe("SileroVAD against the real model", () => {
  // Skipped, not failed, when the model is absent: the buffering tests above
  // cover everything but the model itself, and requiring the binary here would
  // make them run only on machines that happen to have it.
  if (!existsSync(MODEL_PATH)) {
    test("the model file is present", () => {
      console.warn(`Silero model not found at ${MODEL_PATH}; real-model tests skipped`);
    });
    return;
  }

  test("loads and answers with a probability in range", async () => {
    const vad = await SileroVAD.create({ modelPath: MODEL_PATH });

    // Silence is not speech: the score must be low, and always a probability.
    const [score] = await vad.process(new Float32Array(WINDOW_SIZE));

    expect(score).toBeLessThan(0.1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test("scores a window twice the same, from a reset state", async () => {
    // The model is recurrent, so the same window scores differently depending
    // on what it has heard. Resetting returns it to the same cold start, which
    // is what makes two readings of the same audio comparable.
    const vad = await SileroVAD.create({ modelPath: MODEL_PATH });
    const window = Float32Array.from(
      { length: WINDOW_SIZE },
      (_, i) => Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.5,
    );

    await vad.process(window);
    vad.reset();
    const first = await vad.process(window);
    vad.reset();
    const second = await vad.process(window);

    expect(second[0]).toBe(first[0]);
  });
});
