/**
 * A WebSocket server that runs one pipeline per connection.
 *
 * The transport knows how to turn socket events into frames; the server is
 * what owns connections. For each client that connects it builds a pipeline,
 * starts it, and routes that socket's events to that pipeline's transport.
 * The builder is the seam where an application decides what the pipeline
 * contains — the server itself has no opinion.
 */

import { type Pipeline } from "../core/pipeline.ts";
import { type ClientSocket } from "./socket.ts";
import { WebSocketTransport } from "./websocket-transport.ts";

/**
 * How a session is assembled for a connection.
 *
 * The rates are fixed for every session the server runs; a pipeline's own
 * start frame carries them to the stages.
 */
export interface SessionConfig {
  /** The rate audio arrives from clients at. */
  readonly sampleRateIn: number;
  /** The rate audio is sent to clients at. */
  readonly sampleRateOut: number;
}

/** Builds the pipeline and transport for one connection. */
export type SessionBuilder = (transport: WebSocketTransport) => Pipeline;

/** A connection the server is running a session for. */
interface Session {
  readonly transport: WebSocketTransport;
  readonly pipeline: Pipeline;
}

export class WebSocketServer {
  readonly #config: SessionConfig;
  readonly #build: SessionBuilder;
  readonly #sessions = new Map<ClientSocket, Session>();

  /**
   * @param config The rates every session runs at.
   * @param build Assembles a pipeline around a connection's transport.
   */
  constructor(config: SessionConfig, build: SessionBuilder) {
    this.#config = config;
    this.#build = build;
  }

  /** How many connections are currently being served. */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * Start a session for a new connection.
   *
   * @param socket The connection to serve.
   * @returns The pipeline that was started.
   */
  handleOpen(socket: ClientSocket): Pipeline {
    const transport = new WebSocketTransport(socket, {
      clientSampleRateIn: this.#config.sampleRateIn,
      clientSampleRateOut: this.#config.sampleRateOut,
    });

    const pipeline = this.#build(transport);
    this.#sessions.set(socket, { transport, pipeline });

    transport.handleConnected();

    // A failed session must not leave its entry behind, or the server would
    // leak one record per crash and report connections it is not serving.
    void pipeline.start(this.#config).catch(() => {
      this.#sessions.delete(socket);
    });

    return pipeline;
  }

  /**
   * Route a message from a connection to its session.
   *
   * A message for an unknown connection is ignored: it can only arrive after
   * the session has already ended.
   *
   * @param socket The connection the message came from.
   * @param message The message.
   */
  handleMessage(socket: ClientSocket, message: string | Uint8Array): void {
    this.#sessions.get(socket)?.transport.handleMessage(message);
  }

  /**
   * End the session for a connection that has gone away.
   *
   * The session is forgotten immediately, so a later message from the same
   * socket cannot reach a transport that is shutting down.
   *
   * @param socket The connection that closed.
   */
  handleClose(socket: ClientSocket): void {
    const session = this.#sessions.get(socket);
    if (session === undefined) {
      return;
    }

    this.#sessions.delete(socket);
    session.transport.handleDisconnect();
  }

  /**
   * Stop every session and wait for them all to exit.
   *
   * Used on shutdown, so that in-flight work is drained rather than abandoned.
   */
  async stopAll(): Promise<void> {
    const pipelines = [...this.#sessions.values()].map((session) => session.pipeline);
    this.#sessions.clear();

    await Promise.all(pipelines.map((pipeline) => pipeline.stop().catch(() => undefined)));
  }
}
