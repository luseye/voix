/**
 * Speech probability through the Silero VAD model.
 *
 * Silero is a small ONNX network that reads a window of audio and answers one
 * question: how likely is this speech? It carries state between windows — an
 * LSTM — so the same audio scores differently depending on what came before it,
 * and it must be fed fixed-size windows at a known sample rate.
 *
 * This class is the boundary to that model and nothing more. It buffers audio
 * into windows, runs each one, and reports the probabilities. Deciding what the
 * numbers *mean* — when speech starts, when it stops — belongs to the state
 * machine in `vad.ts`, which is what makes that state machine testable without
 * a model at all.
 */

import { InferenceSession, Tensor } from "onnxruntime-node";

/**
 * The samples per window Silero was trained on at 16 kHz.
 *
 * One window is 32 ms of audio. The model accepts other sizes close to this,
 * but its accuracy is tuned to what it was trained on, and a fixed window is
 * also what makes the timing predictable: one inference per 32 ms, never more.
 */
export const WINDOW_SIZE = 512;

/** The sample rate Silero expects. The session is already 16 kHz end to end. */
export const SAMPLE_RATE = 16000;

/** How Silero is configured. */
export interface SileroOptions {
  /**
   * The path to the model file.
   *
   * Not bundled: it is a 2 MB binary, and a framework that ships one would
   * have to keep it current. Download `silero_vad.onnx` from the
   * [silero-vad repository](https://github.com/snakers4/silero-vad) and pass
   * the path here.
   */
  readonly modelPath: string;
}

/** The session surface this class uses, so tests can stand in for the model. */
interface OnnxSession {
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}

/** Raised when the model file is missing or is not a model at all. */
export class ModelLoadError extends Error {}

export class SileroVAD {
  readonly #session: OnnxSession;
  // The model's recurrent memory. Fed back with every window, which is how the
  // model knows what the audio sounded like before this window.
  #state: Tensor;

  // Audio that does not fill a window yet, waiting for the rest.
  #buffer = new Float32Array(0);

  private constructor(session: OnnxSession) {
    this.#session = session;
    this.#state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  }

  /**
   * Load the model from disk.
   *
   * Separated from the constructor because loading is asynchronous and can
   * fail — a missing or corrupt file should be an exception the caller sees at
   * startup, not a half-constructed object that fails on its first window.
   *
   * @param options Where the model lives.
   * @param session The session to run the model on. Defaults to a real
   *   `onnxruntime-node` session; tests stand in for it.
   * @returns A detector ready to score audio.
   */
  static async create(
    options: SileroOptions,
    session?: OnnxSession,
  ): Promise<SileroVAD> {
    let loaded: OnnxSession;
    if (session !== undefined) {
      loaded = session;
    } else {
      try {
        loaded = await InferenceSession.create(options.modelPath);
      } catch (error) {
        throw new ModelLoadError(
          `Could not load the Silero VAD model at ${options.modelPath}: ${String(error)}`,
        );
      }
    }
    return new SileroVAD(loaded);
  }

  /**
   * Score audio, one probability per complete window.
   *
   * Audio that does not fill a whole window is held back — the model wants
   * exactly `WINDOW_SIZE` samples, and inventing padding would score audio the
   * caller never sent. The window count is therefore floor(n / 512): send less
   * than one window and nothing is scored yet.
   *
   * @param samples 16 kHz mono audio, -1 to 1.
   * @returns One speech probability per complete window, in order.
   */
  async process(samples: Float32Array): Promise<number[]> {
    const probabilities: number[] = [];

    // Joined with whatever was left over, so a window split across calls is
    // scored once its second half arrives.
    const buffered =
      this.#buffer.length === 0
        ? samples
        : (() => {
            const joined = new Float32Array(this.#buffer.length + samples.length);
            joined.set(this.#buffer, 0);
            joined.set(samples, this.#buffer.length);
            return joined;
          })();

    for (const start of range(0, buffered.length - WINDOW_SIZE + 1, WINDOW_SIZE)) {
      probabilities.push(await this.#run(buffered.subarray(start, start + WINDOW_SIZE)));
    }

    const used = probabilities.length * WINDOW_SIZE;
    this.#buffer = buffered.slice(used);

    return probabilities;
  }

  /** Forget what the model has heard, so the next window is scored cold. */
  reset(): void {
    this.#state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  }

  /** Run one window through the model, carrying the state forward. */
  async #run(window: Float32Array): Promise<number> {
    const input = new Tensor("float32", Float32Array.from(window), [1, WINDOW_SIZE]);
    const result = await this.#session.run({ input, state: this.#state, sr: SR_TENSOR });
    this.#state = result.stateN as Tensor;
    const output = result.output as Tensor;
    return output.data[0] as number;
  }
}

// The rate never changes for a detector, so the tensor is built once.
const SR_TENSOR = new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

/** Count by `step` from `start` while below `stop`. */
function range(start: number, stop: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value < stop; value += step) {
    values.push(value);
  }
  return values;
}
