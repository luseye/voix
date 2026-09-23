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

  /** Whether a failure has already been reported, so it is reported once. */
  #failed = false;

  protected override async process(frame: Frame): Promise<void> {
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

    try {
      await this.handle(frame, connection);
    } catch (error) {
      // One bad frame is one turn lost, not a session over: the connection and
      // the loop stay up, so the next turn can still work. The error frame is
      // what turns a crash into a degraded session.
      this.#report(error);
    }
  }

  /** Report a failure once, as an error frame addressed downstream. */
  #report(error: unknown): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;

    const message = error instanceof Error ? error.message : String(error);
    this.push(createFrame({ kind: "error", source: this.name, message }));
  }

  /** Open the connection, then deliver whatever arrived while it was opening. */
  async #open(start: StartFrame, signal: AbortSignal): Promise<void> {
    let connection: ServiceConnection;
    try {
      connection = await this.connect(start, signal);
    } catch (error) {
      // A failure during shutdown is not a failure: the connection was aborted
      // on purpose, and reporting it would say the service is broken for a
      // session that ended normally.
      if (!signal.aborted) {
        this.#report(error);
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

    signal.addEventListener("abort", () => {
      // Cleared as well as closed, so `connection` does not hand out a socket
      // that is shutting down.
      this.#connection = undefined;
      connection.close();
    });
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

  /**
   * The open connection, once the handshake has finished.
   *
   * For a subclass that has to send something outside `handle` — cancelling
   * work in flight when the pipeline is interrupted, for instance, which is not
   * a frame and so never reaches `handle`. Undefined until the connection is
   * open, and after it closes.
   */
  protected get connection(): ServiceConnection | undefined {
    return this.#connection;
  }

  /**
   * Report a failure and degrade the session.
   *
   * For failures that happen once the connection is open, which `handle`'s own
   * guard cannot catch: a provider that rejects a request over the socket, or a
   * socket that drops mid-session. The failure becomes an `error` frame and the
   * session continues without this service — the turn it was working on is
   * lost, but the session is not.
   *
   * Reported once per connection: a socket that has dropped will fail every
   * send after it, and a dozen error frames about the same dead socket would
   * bury whatever came before them.
   *
   * Safe to call from a socket handler, which is where these failures usually
   * surface, and safe to call after the pipeline has already stopped.
   *
   * @param error What went wrong.
   */
  protected fail(error: unknown): void {
    this.#report(error);
  }
}
