import { describe, expect, test } from "bun:test";

import { LinearResampler } from "../src/audio/resample.ts";

/** A ramp, so every sample is distinct and interpolation is checkable. */
function ramp(length: number): Int16Array {
  return Int16Array.from({ length }, (_, i) => i);
}

/** Resample a whole signal in one call. */
function whole(inputRate: number, outputRate: number, input: Int16Array): number[] {
  return Array.from(new LinearResampler(inputRate, outputRate).process(input));
}

/** Resample the same signal in fixed-size chunks. */
function chunked(
  inputRate: number,
  outputRate: number,
  input: Int16Array,
  size: number,
): number[] {
  const resampler = new LinearResampler(inputRate, outputRate);
  const output: number[] = [];

  for (let i = 0; i < input.length; i += size) {
    output.push(...Array.from(resampler.process(input.subarray(i, i + size))));
  }

  return output;
}

describe("LinearResampler", () => {
  test("rejects a non-positive rate", () => {
    expect(() => new LinearResampler(0, 16000)).toThrow("must be positive");
    expect(() => new LinearResampler(16000, -1)).toThrow("must be positive");
  });

  test("returns an empty result for empty input", () => {
    expect(new LinearResampler(16000, 24000).process(new Int16Array(0))).toHaveLength(0);
  });

  test("passes audio through unchanged when the rates match", () => {
    expect(whole(16000, 16000, Int16Array.from([10, -20, 30, -40]))).toEqual([10, -20, 30, -40]);
  });

  test("interpolates between samples when upsampling", () => {
    // Half a sample step, so the midpoint falls exactly between two samples.
    expect(whole(16000, 32000, Int16Array.from([0, 100]))).toEqual([0, 50, 100]);
  });

  test("rounds interpolated samples to the nearest value", () => {
    // The 16k to 24k step is two thirds, so positions land between samples and
    // the results are fractional: 0.667 rounds to 1, where truncating gives 0.
    expect(whole(16000, 24000, Int16Array.from([0, 1, 2, 3]))).toEqual([0, 1, 1, 2, 3]);
  });

  test("picks samples out when downsampling", () => {
    // A step of 1.5, so the output is a strict subset of the input.
    expect(whole(24000, 16000, Int16Array.from([0, 10, 20, 30, 40, 50]))).toEqual([0, 15, 30, 45]);
  });

  test("keeps interpolated samples within the input range", () => {
    // Interpolating between two samples cannot leave their span, so the result
    // is always a valid 16-bit sample.
    for (const sample of whole(8000, 44100, Int16Array.from([-32768, 32767]))) {
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });

  test("produces the same output however the stream is chunked", () => {
    const input = ramp(160);
    const expected = whole(16000, 24000, input);

    for (const size of [1, 3, 7, 64, 160]) {
      expect(chunked(16000, 24000, input, size)).toEqual(expected);
    }
  });

  test("interpolates across a chunk boundary", () => {
    // The midpoint of the second output sample falls between the two chunks,
    // so it can only be computed from the previous chunk's last sample.
    expect(chunked(16000, 32000, Int16Array.from([0, 100]), 1)).toEqual([0, 50, 100]);
  });

  test("carries state between calls rather than restarting", () => {
    const resampler = new LinearResampler(16000, 32000);

    // A resampler that forgot where it was would restart at the first sample.
    const first = resampler.process(Int16Array.from([0, 100]));
    const second = resampler.process(Int16Array.from([200, 300]));

    expect(Array.from(first)).toEqual([0, 50, 100]);
    expect(Array.from(second)).toEqual([150, 200, 250, 300]);
  });

  test("yields one fewer sample than the exact ratio", () => {
    // The final sample has no right neighbour to interpolate towards, so a
    // stream comes up one sample short when the rates differ.
    expect(whole(16000, 24000, ramp(160))).toHaveLength(160 * (24000 / 16000) - 1);
  });

  test("does not drift over a long stream", () => {
    // The ramp is linear, so a resampler that drifted would stop tracking it.
    const output = whole(16000, 16000, ramp(16000));

    expect(output).toHaveLength(16000);
    expect(output[output.length - 1]).toBe(15999);
  });
});
