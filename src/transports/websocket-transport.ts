/**
 * A WebSocket transport for one client connection.
 *
 * The transport is the single entry point for everything a connection
 * produces: binary messages are audio, text messages are JSON control, and a
 * close ends the session. It owns the two processors that sit at the ends of
 * the pipeline, so a caller assembles a pipeline from `transport.input` and
 * `transport.output` and routes socket events to `handleMessage` and
 * `handleDisconnect`.
 *
 * The session's sample rates are not configured here. They are decided when
 * the pipeline starts and arrive on the start frame, which the processors
 * read; the transport only knows what the client sends and expects.
 *
 * One transport serves one connection: the socket is given at construction
 * and both processors write to it for as long as it lives.
 */

import { createFrame, type FrameBody } from "../frames/index.ts";
import { type ClientSocket } from "./socket.ts";
import { WebSocketInput } from "./websocket-input.ts";
import { WebSocketOutput } from "./websocket-output.ts";

/**
 * Decode a control message from its wire form.
 *
 * The wire uses a `type` field where a frame uses `kind`, so the message is
 * translated rather than passed through. A malformed message is not an error:
 * a client sending something unexpected is a client bug, and closing the
 * session over it would be worse than ignoring it.
 *
 * @param text The message as the client sent it.
 * @returns The frame body it names, or `undefined` if it is not one we
 *   understand.
 */
export function parseControlMessage(text: string): FrameBody | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // Only the field we act on is read; anything else is ignored, so a client
  // may send extra keys without breaking the session.
  if ((value as { type?: unknown }).type === "llmRun") {
    return { kind: "llmRun" };
  }

  return undefined;
}

/** How a transport is configured. */
export interface WebSocketTransportOptions {
  /** The rate the client sends audio at. Defaults to 16000. */
  readonly clientSampleRateIn?: number;
  /** The rate the client expects audio at. Defaults to 24000. */
  readonly clientSampleRateOut?: number;
  /** Called once the connection is ready to carry a session. */
  readonly onClientConnected?: () => void;
  /** Called once the client has gone away. */
  readonly onClientDisconnected?: () => void;
}

export class WebSocketTransport {
  /** The head of the pipeline: client audio in, session audio out. */
  readonly input: WebSocketInput;

  /** The tail of the pipeline: session audio converted for the client. */
  readonly output: WebSocketOutput;

  readonly #options: WebSocketTransportOptions;

  /**
   * @param socket The connection this transport serves.
   * @param options The client's rates and connection callbacks.
   */
  constructor(socket: ClientSocket, options: WebSocketTransportOptions = {}) {
    this.#options = options;

    this.input = new WebSocketInput(options.clientSampleRateIn ?? 16000);
    this.output = new WebSocketOutput(socket, options.clientSampleRateOut ?? 24000);
  }

  /**
   * Handle a message from the client.
   *
   * A text message is a JSON control message; a binary one is audio. Both
   * leave through the same call, `push` on the input processor, so a control
   * frame keeps its place among the audio that arrived around it. A `false`
   * return means the connection is already closing, which is not a failure.
   *
   * @param message What the client sent.
   */
  handleMessage(message: string | Uint8Array): void {
    if (typeof message === "string") {
      const control = parseControlMessage(message);
      if (control !== undefined) {
        this.input.push(createFrame(control));
      }
      return;
    }

    this.input.handleAudio(message);
  }

  /**
   * Announce that the connection is ready.
   *
   * Called by the server once the socket is open, before any audio arrives.
   */
  handleConnected(): void {
    this.#options.onClientConnected?.();
  }

  /**
   * Handle the client going away.
   *
   * The input processor ends the pipeline first, so shutdown begins promptly,
   * and the callback runs afterwards so a listener cannot delay it.
   */
  handleDisconnect(): void {
    this.input.handleDisconnect();
    this.#options.onClientDisconnected?.();
  }
}
