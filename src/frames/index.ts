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

/**
 * How a frame is scheduled relative to other frames.
 *
 * - `start` — the pipeline's opening frame, processed before everything else.
 * - `system` — lifecycle, control, and speaking state, processed before data.
 * - `default` — data frames, processed in arrival order.
 */
export type FrameTier = "start" | "system" | "default";

/** Scheduling metadata for a frame kind. */
interface FrameSpec {
  /** Tier, which determines the frame's queue priority. */
  readonly tier: FrameTier;
  /** Whether an interruption may drop the frame from a queue. */
  readonly interruptible: boolean;
}

/**
 * Scheduling metadata for every frame kind.
 *
 * The `satisfies` clause makes this exhaustive: adding a kind to `FrameBody`
 * without classifying it here is a compile error.
 */
const FRAME_SPECS = {
  start: { tier: "start", interruptible: false },
  end: { tier: "system", interruptible: false },
  cancel: { tier: "system", interruptible: false },
  interrupt: { tier: "system", interruptible: false },

  userStartedSpeaking: { tier: "system", interruptible: false },
  userStoppedSpeaking: { tier: "system", interruptible: false },
  botStartedSpeaking: { tier: "system", interruptible: false },
  botStoppedSpeaking: { tier: "system", interruptible: false },

  inputAudio: { tier: "default", interruptible: true },
  ttsAudio: { tier: "default", interruptible: true },
  transcript: { tier: "default", interruptible: true },
  llmText: { tier: "default", interruptible: true },
  ttsText: { tier: "default", interruptible: true },

  llmRun: { tier: "default", interruptible: true },
} satisfies Record<FrameKind, FrameSpec>;

/** Queue priority per tier. Lower values are dequeued first. */
export const TIER_PRIORITY: Record<FrameTier, number> = {
  start: 1,
  system: 10,
  default: 20,
};

/**
 * Get a frame's queue priority.
 *
 * @param frame The frame to inspect.
 * @returns The priority; lower values are dequeued first.
 */
export function framePriority(frame: Frame): number {
  return TIER_PRIORITY[FRAME_SPECS[frame.kind].tier];
}

/**
 * Whether an interruption may drop this frame from a queue.
 *
 * Lifecycle and speaking state frames survive an interruption so that a
 * pipeline can still be stopped and a turn still recorded. Data frames are
 * discarded, since they describe work that is no longer wanted.
 *
 * @param frame The frame to inspect.
 * @returns `true` if the frame may be discarded on interruption.
 */
export function isInterruptible(frame: Frame): boolean {
  return FRAME_SPECS[frame.kind].interruptible;
}
