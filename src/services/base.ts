/**
 * A base for services that hold a connection to a provider.
 *
 * Speech recognition and speech synthesis both keep a connection open for the
 * whole session, and both need it closed when the session ends. The lifecycle
 * is the same for each, and the ways to get it subtly wrong are the same too,
 * so it lives here rather than being repeated in every service:
 *
 * - The connection opens when the start frame arrives, on a session-scoped
 *   task, so an interruption does not close it. Closing the transcription
 *   connection because the user interrupted would stop transcribing the very
 *   speech that interrupted.
 * - It closes when the session signal aborts, which only shutdown does.
 * - Frames that arrive while it is opening are held and delivered in order
 *   once it is usable. A handshake takes far longer than a frame, and audio
 *   that arrives during one is the beginning of what the user said.
 *
 * The handshake runs on a task rather than inside `process` because it is far
 * too slow to await there: `process` runs on the main loop, so awaiting a
 * handshake in it would stall every frame behind it, including the end frame
 * that shutdown depends on.
 */

import { FrameProcessor } from "../core/frame-processor.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** The start frame, which carries the rates a connection is built from. */
export type StartFrame = Extract<Frame, { kind: "start" }>;

/**
 * A connection to a provider.
 *
 * Binary payloads are audio and strings are JSON, which is what providers
 * accept over a socket.
 */
export interface ServiceConnection {
  /** Send a payload to the provider. */
  send(data: Uint8Array | string): void;

  /** Close the connection. */
  close(): void;
}

export abstract class AIService extends FrameProcessor {
  #connection: ServiceConnection | undefined;

  /** Frames that arrived before the connection was usable, in arrival order. */
  #pending: Frame[] = [];

  /** Whether the backlog is being delivered, which new frames must not overtake. */
  #draining = false;

  #failure: unknown;

  protected override async process(frame: Frame): Promise<void> {
    if (this.#failure !== undefined) {
      // Checked before anything else, so a failure surfaces on the next frame
      // whatever kind it is — including the cancel frame that `#open` queues
      // to make sure one arrives.
      throw this.#failure;
    }

    if (frame.kind === "start") {
      // The start frame is forwarded at once rather than held until the
      // connection opens: a later stage opens its own connection from it, and
      // making that wait for this handshake would serialise every stage's
      // startup. It is not handed to `handle` either, since `connect` already
      // received it and forwarding it again would duplicate it downstream.
      this.createSessionTask((signal) => this.#open(frame, signal));
      this.push(frame);
      return;
    }

    if (frame.kind === "end" || frame.kind === "cancel") {
      // Held frames will never be delivered, and waiting for a connection that
      // is still opening would delay shutdown by the length of a handshake.
      this.#pending = [];
      this.push(frame);
      return;
    }

    const connection = this.#connection;
    if (connection === undefined || this.#draining) {
      // Held because the connection is not open yet, or because delivering it
      // now would overtake the frames that arrived before it.
      this.#pending.push(frame);
      return;
    }

    await this.handle(frame, connection);
  }

  /** Open the connection, then deliver whatever arrived while it was opening. */
  async #open(start: StartFrame, signal: AbortSignal): Promise<void> {
    let connection: ServiceConnection;
    try {
      connection = await this.connect(start, signal);
    } catch (error) {
      // A failure during shutdown is not a failure: the connection was aborted
      // on purpose, and recording it would report a broken service for a
      // session that ended normally.
      //
      // The branch is reached whenever a handshake is still in flight when the
      // session ends, but it is not load-bearing today: shutdown closes the
      // queue before aborting this signal, so the wake below finds a closed
      // queue and the failure is discarded either way. It is kept because the
      // distinction is real and the cost of losing it is a spurious failure if
      // that ordering ever changes.
      if (!signal.aborted) {
        this.#failure = error;

        // Wake the loop so it observes the failure. Without this it would stay
        // blocked on an empty queue: the frame that triggered the handshake was
        // already consumed, and clearing the backlog leaves nothing to process.
        // The loop's next `process` call throws the failure and stops the
        // pipeline, which is the honest outcome — a stage that silently does
        // nothing is worse than one that stops.
        //
        // Guarded because the loop may have stopped while the handshake was
        // still running, in which case there is nothing left to fail.
        try {
          this.enqueue(createFrame({ kind: "cancel" }));
        } catch {
          // The queue is already closed, so the pipeline has stopped and the
          // failure no longer has anywhere to go.
        }
      }
      this.#pending = [];
      return;
    }

    if (signal.aborted) {
      // Shutdown landed while the connection was opening. Registering the
      // close below would do nothing, because the signal has already fired.
      connection.close();
      this.#pending = [];
      return;
    }

    signal.addEventListener("abort", () => connection.close());
    this.#connection = connection;

    // This flag is what keeps order. A frame arriving while the loop below
    // awaits would otherwise be handled straight away, overtaking the frames
    // still in the backlog.
    this.#draining = true;
    try {
      for (
        let frame = this.#pending.shift();
        frame !== undefined;
        frame = this.#pending.shift()
      ) {
        await this.handle(frame, connection);
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Open the connection to the provider.
   *
   * Runs on a session-scoped task, so the signal aborts on shutdown but not on
   * an interruption.
   *
   * Must settle. A connection that never resolves would leave the pipeline
   * unable to shut down, so use a timeout.
   *
   * @param start The start frame, which carries the session's rates.
   * @param signal Aborted when the session ends.
   * @returns The open connection.
   */
  protected abstract connect(start: StartFrame, signal: AbortSignal): Promise<ServiceConnection>;

  /**
   * Handle one frame, with a connection that is open.
   *
   * Runs on the main loop, so it must return promptly: anything slower belongs
   * on a task.
   *
   * @param frame The frame to handle.
   * @param connection The open connection.
   */
  protected abstract handle(frame: Frame, connection: ServiceConnection): Promise<void>;
}
