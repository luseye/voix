/**
 * The browser's side of the audio protocol.
 *
 * A browser works in `Float32Array` samples at whatever rate the audio device
 * runs at, and the pipeline works in 16-bit mono PCM at fixed rates. This is
 * the conversion between them, kept apart from the page so it can be tested:
 * getting a rate or a byte order wrong produces noise rather than an error,
 * which is the kind of bug that is hard to place from inside a browser.
 *
 * It reuses the framework's own resampler and byte conversion, so both sides of
 * the wire agree on the format by construction rather than by both happening to
 * be written the same way.
 */

import { readSamples, writeSamples } from "../src/audio/pcm.ts";
import { LinearResampler } from "../src/audio/resample.ts";

/** The rate the pipeline expects audio at, which the server is configured with. */
export const SEND_RATE = 16000;

/** The rate the pipeline produces audio at. */
export const RECEIVE_RATE = 24000;

/**
 * Convert audio samples from the range a browser uses to 16-bit PCM.
 *
 * The browser's range is -1 to 1. Values outside it are clamped rather than
 * allowed to wrap: a sample that clips is heard as a click, while a wrapped one
 * is heard as a loud crack.
 *
 * @param samples Samples in the browser's range.
 * @returns The same audio as 16-bit samples.
 */
export function toPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    pcm[i] = Math.round(clamped * 32767);
  }

  return pcm;
}

/**
 * Convert 16-bit PCM to the range a browser uses.
 *
 * Divided by 32768 rather than 32767, which is what makes the range symmetric:
 * the most negative sample becomes exactly -1.
 *
 * @param pcm The 16-bit samples.
 * @returns The same audio in the browser's range.
 */
export function toFloat(pcm: Int16Array): Float32Array {
  const samples = new Float32Array(pcm.length);

  for (let i = 0; i < pcm.length; i++) {
    samples[i] = pcm[i]! / 32768;
  }

  return samples;
}

/**
 * Turns microphone audio into the bytes the pipeline expects.
 *
 * The resampler is stateful across calls, which is why this is a class: a
 * microphone delivers audio in small chunks, and resampling each one on its own
 * would leave a seam at every boundary.
 */
export class MicrophoneEncoder {
  readonly #resampler: LinearResampler;

  /**
   * @param contextRate The rate the browser's microphone runs at.
   * @param sendRate The rate the pipeline expects. Defaults to `SEND_RATE`.
   */
  constructor(contextRate: number, sendRate = SEND_RATE) {
    this.#resampler = new LinearResampler(contextRate, sendRate);
  }

  /**
   * Convert one chunk of microphone audio.
   *
   * @param samples One chunk, in the browser's range.
   * @returns The bytes to send, little-endian 16-bit mono.
   */
  encode(samples: Float32Array): Uint8Array {
    return writeSamples(this.#resampler.process(toPcm(samples)));
  }
}

/**
 * Turns the pipeline's audio into something a browser can play.
 *
 * Stateful for the same reason as `MicrophoneEncoder`: the reply arrives in
 * chunks, and each one has to continue from where the last left off.
 */
export class PlaybackDecoder {
  readonly #resampler: LinearResampler;

  /**
   * @param contextRate The rate the browser plays at.
   * @param receiveRate The rate the pipeline produces. Defaults to `RECEIVE_RATE`.
   */
  constructor(contextRate: number, receiveRate = RECEIVE_RATE) {
    this.#resampler = new LinearResampler(receiveRate, contextRate);
  }

  /**
   * Convert one chunk of the reply.
   *
   * @param bytes The bytes received, little-endian 16-bit mono.
   * @returns The samples to play, in the browser's range.
   */
  decode(bytes: Uint8Array): Float32Array {
    // `readSamples` reads whole samples and takes an even byte count, but a
    // message can split a two-byte sample across its boundary, so an odd
    // trailing byte is dropped before it is passed on.
    const usable = bytes.length - (bytes.length % 2);

    return toFloat(this.#resampler.process(readSamples(bytes, usable)));
  }
}
