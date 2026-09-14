/**
 * Conversion between 16-bit mono PCM samples and wire bytes.
 *
 * A pipeline carries audio as `Int16Array` samples; a transport carries it as
 * bytes. Both directions of a connection must agree on the byte order, so it
 * is defined once here and stated explicitly rather than inherited from the
 * platform — an `Int16Array` view would use the machine's own order, which is
 * little-endian everywhere this is likely to run but is not guaranteed to be.
 */

/** The number of bytes one sample occupies on the wire. */
export const BYTES_PER_SAMPLE = 2;

/**
 * Read the first `length` bytes as little-endian 16-bit samples.
 *
 * @param bytes The buffer to read from. Reading starts at the view's own
 *   offset, so a view into a larger buffer reads from where it points.
 * @param length How many bytes to read, which must be even.
 * @returns The samples those bytes encode.
 */
export function readSamples(bytes: Uint8Array, length: number): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const samples = new Int16Array(length / BYTES_PER_SAMPLE);

  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * BYTES_PER_SAMPLE, true);
  }

  return samples;
}

/**
 * Write samples as little-endian bytes.
 *
 * @param samples The samples to write.
 * @returns The bytes those samples encode.
 */
export function writeSamples(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * BYTES_PER_SAMPLE, samples[i]!, true);
  }

  return bytes;
}
