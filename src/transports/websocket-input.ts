/**
 * The input side of a WebSocket transport.
 *
 * Audio from a client arrives as raw 16-bit mono PCM in little-endian byte
 * order, at whatever rate the client chose. This processor turns those bytes
 * into `inputAudio` frames at the session's rate, so nothing downstream has to
 * think about either the wire format or the client's rate.
 *
 * The session rate is not known until the start frame arrives, so bytes that
 * arrive earlier are held rather than converted. A message may also split a
 * two-byte sample across its boundary, so the trailing byte is held the same
 * way. Both cases are the same buffer: bytes that cannot be converted yet.
 */

import { LinearResampler } from "../audio/resample.ts";
import { FrameProcessor } from "../core/frame-processor.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** Joins two byte runs into a fresh buffer. */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (right.length === 0) {
    return left;
  }
  if (left.length === 0) {
    // Copied, because the caller owns `right` and may reuse its buffer.
    return right.slice();
  }

  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

/**
 * Reads the first `length` bytes as little-endian 16-bit samples.
 *
 * The byte order is stated rather than assumed: an `Int16Array` view would use
 * the platform's order, which is little-endian everywhere this is likely to
 * run but is not guaranteed to be.
 */
function readSamples(bytes: Uint8Array, length: number): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const samples = new Int16Array(length / 2);

  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }

  return samples;
}

export class WebSocketInput extends FrameProcessor {
  readonly #clientSampleRate: number;
  #resampler: LinearResampler | undefined;
  // Annotated rather than inferred: `slice` yields a wider buffer type than a
  // fresh Uint8Array does, and the field holds both.
  #pending: Uint8Array = new Uint8Array(0);

  /**
   * @param clientSampleRate The rate the client sends audio at.
   * @param name A label for logs.
   */
  constructor(clientSampleRate: number, name?: string) {
    super(name ?? "WebSocketInput");

    if (!Number.isInteger(clientSampleRate) || clientSampleRate <= 0) {
      throw new Error("Client sample rate must be a positive integer");
    }

    this.#clientSampleRate = clientSampleRate;
  }

  /** The session's rate, once the start frame has arrived. */
  get sessionRate(): number | undefined {
    return this.#resampler?.outputRate;
  }

  /**
   * Take a binary message from the client.
   *
   * Safe to call before the pipeline starts: the bytes are held until the
   * session rate is known, then converted.
   *
   * @param bytes The raw PCM the client sent.
   */
  handleAudio(bytes: Uint8Array): void {
    this.#pending = concat(this.#pending, bytes);
    this.#convertPending();
  }

  /**
   * Handle the client going away.
   *
   * The end frame travels downstream so every later stage stops, and this
   * processor stops too. Driving the shutdown from the transport is what keeps
   * it complete: leaving this stage running would leak a loop that can never
   * receive anything again.
   */
  handleDisconnect(): void {
    this.push(createFrame({ kind: "end" }));
    this.close();
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "start") {
      // The start frame is where the session's rate becomes known.
      this.#resampler = new LinearResampler(this.#clientSampleRate, frame.sampleRateIn);
    }

    // Forwarded before any held audio, so downstream sees the start frame
    // first by arrival rather than only by priority.
    this.push(frame);

    if (frame.kind === "start") {
      this.#convertPending();
    }
  }

  /** Convert whatever pending bytes are now complete. */
  #convertPending(): void {
    const resampler = this.#resampler;
    if (resampler === undefined) {
      return;
    }

    // A trailing odd byte is half a sample; it waits for its other half.
    const usable = this.#pending.length - (this.#pending.length % 2);
    if (usable === 0) {
      return;
    }

    const samples = readSamples(this.#pending, usable);
    this.#pending = this.#pending.slice(usable);

    const output = resampler.process(samples);
    if (output.length > 0) {
      this.push(createFrame({ kind: "inputAudio", data: output }));
    }
  }
}
