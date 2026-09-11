/**
 * Frame definitions.
 *
 * Every piece of data moving through a pipeline — audio, text, control
 * signals — is a frame. Frames are a discriminated union keyed on `kind`, so
 * the compiler checks that a `switch` over a frame handles every case.
 */

/**
 * The direction a frame travels through a pipeline.
 *
 * - `down` — input towards output, the normal path for data.
 * - `up` — output back towards input, used for errors and acknowledgements.
 */
export type Direction = "down" | "up";

/**
 * Lifecycle and control frames.
 *
 * These are processed ahead of data frames and survive an interruption.
 */
export type SystemFrame =
  | { kind: "start"; sampleRateIn: number; sampleRateOut: number }
  | { kind: "end" }
  | { kind: "cancel" }
  | { kind: "interrupt" };

/**
 * Raw audio.
 *
 * Audio inside a pipeline is always 16-bit mono PCM. Converting to and from a
 * transport's own format happens at the transport boundary, so services never
 * have to think about sample rates.
 */
export type AudioFrame =
  | { kind: "inputAudio"; data: Int16Array }
  | { kind: "ttsAudio"; data: Int16Array };

/** Recognised or generated text. */
export type TextFrame =
  | { kind: "transcript"; text: string; final: boolean }
  | { kind: "llmText"; text: string }
  | { kind: "ttsText"; text: string };

/**
 * Speaking state transitions.
 *
 * Emitted by voice activity detection and by the speech synthesis service.
 * They drive turn taking and interruptions.
 */
export type SpeechFrame =
  | { kind: "userStartedSpeaking" }
  | { kind: "userStoppedSpeaking" }
  | { kind: "botStartedSpeaking" }
  | { kind: "botStoppedSpeaking" };

/** Instructions addressed to the language model. */
export type LLMControlFrame = { kind: "llmRun" };

/** The body of any frame, before it is given an id. */
export type FrameBody =
  | SystemFrame
  | AudioFrame
  | TextFrame
  | SpeechFrame
  | LLMControlFrame;

/** Every frame kind, as a union of string literals. */
export type FrameKind = FrameBody["kind"];

/**
 * A frame in flight.
 *
 * The id is assigned on creation and never reused, which makes a single
 * frame's path through the pipeline traceable in logs.
 */
export type Frame = FrameBody & { readonly id: number };

let nextFrameId = 0;

/**
 * Create a frame, assigning it the next id.
 *
 * The body type is preserved, so a frame built from an audio body is still
 * known to carry audio data.
 *
 * @param body The frame's contents.
 * @returns The frame, with an id attached.
 */
export function createFrame<T extends FrameBody>(body: T): T & { readonly id: number } {
  return { ...body, id: nextFrameId++ };
}
