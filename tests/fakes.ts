/**
 * Test doubles for the providers the framework talks to.
 *
 * Each one is a real local server speaking the provider's wire protocol, so a
 * test exercises the actual socket handling rather than a stubbed-out service.
 * That matters because most of what a service gets wrong is in the protocol:
 * the header it authenticates with, the format it asks for, the message shape
 * it parses.
 *
 * They live together because a test of the whole pipeline needs all three at
 * once, and a copy of each inside every test file would drift.
 */

import { writeSamples } from "../src/audio/pcm.ts";

/** Waits until a condition holds, so tests do not depend on timing. */
export async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

/** Base64 of little-endian 16-bit samples, as an audio provider sends them. */
export function encode(samples: number[]): string {
  return Buffer.from(writeSamples(Int16Array.from(samples))).toString("base64");
}

/** A fake Deepgram, so the wire protocol is exercised without an API key. */
export class FakeDeepgram {
  readonly #server: Bun.Server<undefined>;
  /** The authorization header each connection presented. */
  readonly authHeaders: (string | null)[] = [];
  /** The query each connection used. */
  readonly queries: URLSearchParams[] = [];
  /** Binary payloads received, and control messages. */
  readonly audio: Uint8Array[] = [];
  readonly control: string[] = [];
  #socket: Bun.ServerWebSocket<undefined> | undefined;

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        this.authHeaders.push(request.headers.get("authorization"));
        this.queries.push(url.searchParams);
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("expected a WebSocket", { status: 426 });
      },
      websocket: {
        open: (socket) => {
          this.#socket = socket;
        },
        message: (_socket, message) => {
          if (typeof message === "string") {
            this.control.push(message);
          } else {
            // Bun hands binary messages over as a Buffer, which is already a
            // Uint8Array.
            this.audio.push(new Uint8Array(message));
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://localhost:${this.#server.port}/v1/listen`;
  }

  /** Send a message to the connected client, as Deepgram would. */
  send(message: unknown): void {
    this.#socket?.send(JSON.stringify(message));
  }

  /** Send raw bytes, for the case where the payload is not JSON at all. */
  sendRaw(payload: string): void {
    this.#socket?.send(payload);
  }

  /** Drop the socket to the client, as a network failure would. */
  drop(): void {
    this.#socket?.close(1006, "connection dropped");
  }

  stop(): void {
    this.#server.stop(true);
  }
}

/** A fake OpenAI, so the wire protocol is exercised without an API key. */
export class FakeOpenAI {
  readonly #server: Bun.Server<undefined>;
  /** The authorization header each request presented. */
  readonly authHeaders: (string | null)[] = [];
  /** The parsed body of each request. */
  readonly bodies: Record<string, unknown>[] = [];
  /** Events to send, in order, once a request arrives. */
  #events: string[] = [];
  /** Whether the reply should be held open instead of ending. */
  #hold = false;
  #held: (() => void) | undefined;
  /** A status to fail with instead of streaming, when set. */
  #status = 200;

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        this.authHeaders.push(request.headers.get("authorization"));
        this.bodies.push((await request.json()) as Record<string, unknown>);

        if (this.#status !== 200) {
          return new Response("nope", { status: this.#status });
        }

        const events = this.#events;
        const held = this.#hold;
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const encoder = new TextEncoder();
            for (const event of events) {
              controller.enqueue(encoder.encode(event));
            }
            if (held) {
              // Keep the reply open so a test can interrupt mid-stream.
              this.#held = () => controller.close();
              return;
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
  }

  get url(): string {
    return `http://localhost:${this.#server.port}/v1/chat/completions`;
  }

  /** Reply with the given fragments, then end the stream. */
  reply(...fragments: string[]): void {
    this.#events = [...fragments.map((text) => event(chunk(text))), event("[DONE]")];
  }

  /** Reply with the given fragments and keep the stream open. */
  replyAndHold(...fragments: string[]): void {
    this.#events = fragments.map((text) => event(chunk(text)));
    this.#hold = true;
  }

  /** Release a stream held open by `replyAndHold`. */
  release(): void {
    this.#held?.();
  }

  /** Fail every request with the given status. */
  fail(status: number): void {
    this.#status = status;
  }

  stop(): void {
    this.#server.stop(true);
  }
}

/** Build one server-sent event carrying `payload`. */
export function event(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

/** A stream chunk carrying a fragment of the reply. */
export function chunk(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

/** A fake Cartesia, so the wire protocol is exercised without an API key. */
export class FakeCartesia {
  readonly #server: Bun.Server<undefined>;
  /** The API key header each connection presented. */
  readonly apiKeys: (string | null)[] = [];
  /** The version each connection requested. */
  readonly versions: (string | null)[] = [];
  /** Generation requests received, parsed. */
  readonly requests: Record<string, unknown>[] = [];
  /** Cancellation requests received, parsed. */
  readonly cancels: Record<string, unknown>[] = [];
  #socket: Bun.ServerWebSocket<undefined> | undefined;

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        this.apiKeys.push(request.headers.get("x-api-key"));
        this.versions.push(url.searchParams.get("cartesia_version"));
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("expected a WebSocket", { status: 426 });
      },
      websocket: {
        open: (socket) => {
          this.#socket = socket;
        },
        message: (_socket, message) => {
          if (typeof message !== "string") {
            return;
          }
          const parsed = JSON.parse(message) as Record<string, unknown>;
          if (parsed.cancel === true) {
            this.cancels.push(parsed);
          } else {
            this.requests.push(parsed);
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://localhost:${this.#server.port}/tts/websocket`;
  }

  /** The context id of the most recent generation request. */
  get lastContextId(): string {
    return this.requests[this.requests.length - 1]!.context_id as string;
  }

  /** Send an audio chunk for a context, as Cartesia would. */
  chunk(contextId: string, samples: number[]): void {
    this.#socket?.send(JSON.stringify({ type: "chunk", data: encode(samples), context_id: contextId }));
  }

  /** Send the completion signal for a context. */
  done(contextId: string): void {
    this.#socket?.send(JSON.stringify({ type: "done", done: true, context_id: contextId }));
  }

  /** Send an error for a context, or globally when none is given. */
  error(message: unknown): void {
    this.#socket?.send(JSON.stringify(message));
  }

  /** Send a payload that is not JSON at all. */
  sendRaw(payload: string): void {
    this.#socket?.send(payload);
  }

  /** Drop the socket to the client, as a network failure would. */
  drop(): void {
    this.#socket?.close(1006, "connection dropped");
  }

  stop(): void {
    this.#server.stop(true);
  }
}
