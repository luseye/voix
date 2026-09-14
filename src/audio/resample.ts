/**
 * Sample rate conversion for 16-bit mono PCM.
 *
 * Audio arrives in chunks, so the resampler carries state between calls: a
 * chunk cannot be converted on its own, because output samples near a chunk
 * boundary interpolate between the last sample of one chunk and the first of
 * the next. Feeding a stream in chunks produces exactly the same output as
 * feeding it in one piece.
 *
 * Interpolation is linear, which is enough for speech and keeps the resampler
 * dependency-free.
 */

export class LinearResampler {
  /** The rate of the audio this resampler is given. */
  readonly inputRate: number;

  /** The rate of the audio it produces. */
  readonly outputRate: number;

  /** Input samples per output sample. Below one means upsampling. */
  readonly #step: number;

  /** Input samples taken so far, across every chunk. */
  #consumed = 0;

  /** Output samples produced so far, across every chunk. */
  #emitted = 0;

  /** The last input sample of the previous chunk, for boundary interpolation. */
  #previous: number | undefined;

  /**
   * @param inputRate The rate of the audio to be given to `process`.
   * @param outputRate The rate of the audio to be produced.
   */
  constructor(inputRate: number, outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) {
      throw new Error("Sample rates must be positive");
    }

    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.#step = inputRate / outputRate;
  }

  /**
   * Convert one chunk, carrying the rest of the stream in state.
   *
   * Chunking does not change the output: feeding a stream in pieces produces
   * exactly what feeding it whole produces. An output sample is emitted only
   * once the input samples it interpolates between are available, so a sample
   * near a chunk boundary may be held back until the next chunk.
   *
   * That same rule costs the final sample of a stream, which has no right
   * neighbour to interpolate towards. A stream of N input samples therefore
   * yields slightly fewer than N * outputRate / inputRate samples — one short
   * when the rates differ, and exactly N when they are equal and no
   * interpolation is needed.
   *
   * @param input A chunk of input audio.
   * @returns The output audio this chunk completed.
   */
  process(input: Int16Array): Int16Array {
    if (input.length === 0) {
      return new Int16Array(0);
    }

    const output: number[] = [];

    while (true) {
      // Position is derived from the running counts rather than accumulated,
      // so rounding error cannot drift over a long stream.
      const position = this.#emitted * this.#step - this.#consumed;
      const index = Math.floor(position);
      const fraction = position - index;

      // Index -1 is the previous chunk's last sample, which is what lets an
      // output sample sit between two chunks.
      const left = index === -1 ? this.#previous : input[index];
      if (left === undefined) {
        break;
      }

      let value: number;
      if (fraction === 0) {
        // The output sample lands exactly on an input sample, so there is
        // nothing to interpolate and no right neighbour is needed. Requiring
        // one here would drop the last sample of every chunk when the rates
        // are equal.
        value = left;
      } else {
        const right = input[index + 1];
        if (right === undefined) {
          break;
        }
        value = left + (right - left) * fraction;
      }

      output.push(Math.round(value));
      this.#emitted++;
    }

    this.#consumed += input.length;
    this.#previous = input[input.length - 1];

    return Int16Array.from(output);
  }
}
