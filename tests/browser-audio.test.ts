/**
 * The browser's audio conversion.
 *
 * These are the parts of the page that fail silently: a wrong sample rate or
 * byte order still produces audio, just the wrong audio. Testing them here
 * rather than in a browser is also what keeps them covered without a
 * microphone, an audio device, or a person listening.
 */

import { describe, expect, test } from "bun:test";

import { readSamples, writeSamples } from "../src/audio/pcm.ts";
import {
  MicrophoneEncoder,
  PlaybackDecoder,
  RECEIVE_RATE,
  SEND_RATE,
  toFloat,
  toPcm,
} from "../examples/browser-audio.ts";

/** A browser's audio device rate, which is neither of the pipeline's rates. */
const DEVICE_RATE = 48000;

describe("toPcm", () => {
  test("maps the browser's range onto 16-bit samples", () => {
    expect(toPcm(Float32Array.from([0, 1, -1]))).toEqual(Int16Array.from([0, 32767, -32767]));
  });

  test("rounds to the nearest sample", () => {
    // 0.5 of the positive range is 16383.5, which rounds up.
    expect(toPcm(Float32Array.from([0.5]))).toEqual(Int16Array.from([16384]));
  });

  test("clamps a sample that would overflow", () => {
    // Clamping rather than wrapping: a clipped sample is heard as a click, a
    // wrapped one as a loud crack.
    expect(toPcm(Float32Array.from([2, -2]))).toEqual(Int16Array.from([32767, -32767]));
  });

  test("converts an empty chunk to nothing", () => {
    expect(toPcm(new Float32Array(0)).length).toBe(0);
  });
});

describe("toFloat", () => {
  test("maps 16-bit samples onto the browser's range", () => {
    expect(toFloat(Int16Array.from([0, 32767, -32768]))).toEqual(
      Float32Array.from([0, 32767 / 32768, -1]),
    );
  });

  test("divides by 32768 so the range is symmetric", () => {
    // The most negative sample has to land exactly on -1; dividing by 32767
    // would put it just past it.
    expect(toFloat(Int16Array.from([-32768]))[0]).toBe(-1);
  });
});

describe("MicrophoneEncoder", () => {
  test("resamples the device's rate to the pipeline's", () => {
    const encoder = new MicrophoneEncoder(DEVICE_RATE);

    // A whole second of audio, so the count is the rate itself.
    const bytes = encoder.encode(new Float32Array(DEVICE_RATE));

    expect(readSamples(bytes, bytes.length).length).toBe(SEND_RATE);
  });

  test("writes little-endian 16-bit samples", () => {
    // The device rate matches the send rate, so no interpolation is involved
    // and the bytes are the samples.
    const encoder = new MicrophoneEncoder(SEND_RATE);
    // 1 and -1 are 0x0001 and 0xffff in two's complement.
    const bytes = encoder.encode(Float32Array.from([1 / 32767, -1 / 32767]));

    expect(bytes).toEqual(new Uint8Array([0x01, 0x00, 0xff, 0xff]));
  });

  test("produces the same audio however the stream is chunked", () => {
    // The resampler carries state, so a chunk boundary must not leave a seam.
    // A sine wave makes any discontinuity visible as a difference in output.
    const second = new Float32Array(DEVICE_RATE);
    for (let i = 0; i < second.length; i++) {
      second[i] = Math.sin((2 * Math.PI * 440 * i) / DEVICE_RATE);
    }

    const whole = new MicrophoneEncoder(DEVICE_RATE).encode(second);

    const chunked = new MicrophoneEncoder(DEVICE_RATE);
    const pieces: Uint8Array[] = [];
    for (let start = 0; start < second.length; start += 1024) {
      pieces.push(chunked.encode(second.subarray(start, start + 1024)));
    }
    const joined = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.length;
    }

    // Compared as plain byte lists: `joined` is built from a known-length
    // buffer while `whole` comes back from the encoder, and the two generic
    // buffer types do not unify even though the bytes do.
    expect(Array.from(joined)).toEqual(Array.from(whole));
  });
});

describe("PlaybackDecoder", () => {
  test("resamples the pipeline's rate to the device's", () => {
    const decoder = new PlaybackDecoder(DEVICE_RATE);

    // A whole second, so the count is the rate itself.
    const bytes = new Uint8Array(RECEIVE_RATE * 2);
    const samples = decoder.decode(bytes);

    // One sample short: the last output sample has no right neighbour to
    // interpolate towards, which the resampler documents.
    expect(samples.length).toBe(DEVICE_RATE - 1);
  });

  test("reads little-endian 16-bit samples", () => {
    // The device rate matches the receive rate, so the samples come through
    // unchanged.
    const decoder = new PlaybackDecoder(RECEIVE_RATE);

    const samples = decoder.decode(new Uint8Array([0x01, 0x00, 0xff, 0xff]));

    expect(samples).toEqual(Float32Array.from([1 / 32768, -1 / 32768]));
  });

  test("drops a trailing half sample rather than reading past it", () => {
    // A message can split a two-byte sample across its boundary.
    const decoder = new PlaybackDecoder(RECEIVE_RATE);

    const samples = decoder.decode(new Uint8Array([0x01, 0x00, 0x02]));

    expect(samples.length).toBe(1);
  });

  test("converts nothing to nothing", () => {
    expect(new PlaybackDecoder(DEVICE_RATE).decode(new Uint8Array(0)).length).toBe(0);
    expect(new PlaybackDecoder(DEVICE_RATE).decode(new Uint8Array([0x01])).length).toBe(0);
  });
});

describe("a sine wave survives conversion", () => {
  /**
   * Count how often a signal crosses zero, which is twice per cycle.
   *
   * The frequency is what the ear hears, so it is what a resampling bug
   * changes: the wrong rate stretches or compresses the wave and the tone
   * comes out wrong. Counting crossings checks that without depending on the
   * phase, which resampling shifts.
   */
  function crossings(samples: Float32Array): number {
    let count = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1]! < 0 !== samples[i]! < 0) {
        count++;
      }
    }
    return count;
  }

  /** One second of a 440Hz tone at `rate`. */
  function tone(rate: number): Float32Array {
    const samples = new Float32Array(rate);
    for (let i = 0; i < rate; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / rate);
    }
    return samples;
  }

  test("keeps its pitch through the microphone path", () => {
    // The microphone's rate is the device's; what goes on the wire is 16kHz.
    const bytes = new MicrophoneEncoder(DEVICE_RATE).encode(tone(DEVICE_RATE));
    const sent = toFloat(readSamples(bytes, bytes.length));

    // 440Hz crosses zero 880 times a second. A wrong rate would change this by
    // the ratio of the two rates — a factor of three, not a rounding error.
    expect(crossings(sent)).toBeGreaterThan(870);
    expect(crossings(sent)).toBeLessThan(890);
  });

  test("keeps its pitch through the playback path", () => {
    // The pipeline sends 24kHz; the device plays at its own rate.
    const received = new Uint8Array(writeSamples(toPcm(tone(RECEIVE_RATE))));
    const played = new PlaybackDecoder(DEVICE_RATE).decode(received);

    expect(crossings(played)).toBeGreaterThan(870);
    expect(crossings(played)).toBeLessThan(890);
  });
});
