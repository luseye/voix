import { describe, expect, test } from "bun:test";

import { readSamples, writeSamples } from "../src/audio/pcm.ts";

describe("pcm", () => {
  test("writes samples in little-endian order", () => {
    // 258 is 0x0102, so little-endian is [0x02, 0x01]. Big-endian would be
    // [0x01, 0x02] and read back as 513.
    expect(writeSamples(Int16Array.from([258]))).toEqual(new Uint8Array([0x02, 0x01]));
  });

  test("reads samples in little-endian order", () => {
    expect(readSamples(new Uint8Array([0x02, 0x01]), 2)).toEqual(Int16Array.from([258]));
  });

  test("round-trips every sample value", () => {
    // The extremes are where a sign or width mistake shows up.
    const samples = Int16Array.from([-32768, -1, 0, 1, 32767]);
    expect(readSamples(writeSamples(samples), samples.length * 2)).toEqual(samples);
  });

  test("reads only the requested length", () => {
    // A caller may hand over a buffer with more bytes than one message.
    expect(readSamples(new Uint8Array([0x02, 0x01, 0x04, 0x03]), 2)).toEqual(Int16Array.from([258]));
  });

  test("reads from a view's own offset", () => {
    // A view into the middle of a larger buffer must not read from the start
    // of that buffer.
    const buffer = new Uint8Array([0xff, 0xff, 0x02, 0x01]);
    const view = buffer.subarray(2);

    expect(readSamples(view, 2)).toEqual(Int16Array.from([258]));
  });

  test("produces no bytes for no samples", () => {
    expect(writeSamples(new Int16Array(0))).toHaveLength(0);
  });
});
