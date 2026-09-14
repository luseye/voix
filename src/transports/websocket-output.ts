/**
 * The output side of a WebSocket transport.
 *
 * Audio produced inside a pipeline is 16-bit mono PCM at the session's output
 * rate. A client expects it at the rate it asked for, so this processor
 * converts and writes the bytes to the connection.
 *
 * The processor observes rather than consumes: it sends audio on its way past
 * and forwards every frame downstream, so stages placed after the transport
 * still see the frames it acted on.
 */

import { writeSamples } from "../audio/pcm.ts";
import { LinearResampler } from "../audio/resample.ts";
import { FrameProcessor } from "../core/frame-processor.ts";
import { type Frame } from "../frames/index.ts";
import { type ClientSocket } from "./socket.ts";

export class WebSocketOutput extends FrameProcessor {
  readonly #socket: ClientSocket;
  readonly #clientSampleRate: number;
  #resampler: LinearResampler | undefined;

  // Audio handled before the start frame, held until the session's output rate
  // is known. Discarding it instead would silently lose the beginning of a
  // reply, which is exactly the part a listener notices.
  #pending: Int16Array[] = [];

  /**
   * @param socket The connection to write audio to.
   * @param clientSampleRate The rate the client expects audio at.
   * @param name A label for logs.
   */
  constructor(socket: ClientSocket, clientSampleRate: number, name?: string) {
    super(name ?? "WebSocketOutput");

    if (!Number.isInteger(clientSampleRate) || clientSampleRate <= 0) {
      throw new Error("Client sample rate must be a positive integer");
    }

    this.#socket = socket;
    this.#clientSampleRate = clientSampleRate;
  }

  /** The rate this processor writes at, once the start frame has arrived. */
  get clientRate(): number {
    return this.#clientSampleRate;
  }

  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "start") {
      // The session's output rate becomes known with the start frame.
      this.#resampler = new LinearResampler(frame.sampleRateOut, this.#clientSampleRate);
    } else if (frame.kind === "ttsAudio") {
      if (this.#resampler === undefined) {
        // Queued ahead of the start frame, so the rate is not known yet.
        this.#pending.push(frame.data);
        this.push(frame);
        return;
      }
      this.#sendAudio(frame.data);
    }

    this.push(frame);

    if (frame.kind === "start") {
      // Audio that arrived before the start frame is converted now, in order.
      const pending = this.#pending;
      this.#pending = [];
      for (const samples of pending) {
        this.#sendAudio(samples);
      }
    }
  }

  /** Convert a run of session-rate samples and write it to the client. */
  #sendAudio(samples: Int16Array): void {
    const resampler = this.#resampler;
    if (resampler === undefined) {
      return;
    }

    const output = resampler.process(samples);
    if (output.length > 0) {
      this.#socket.send(writeSamples(output));
    }
  }
}
