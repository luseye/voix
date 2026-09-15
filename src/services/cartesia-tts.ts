/**
 * Speech synthesis through Cartesia's streaming API.
 *
 * Sentences arrive as `ttsText` frames and audio goes out as `ttsAudio` frames.
 * Synthesis is streamed rather than awaited whole: the first audio reaches the
 * user while the rest of the sentence is still being generated, which is most
 * of what makes a reply feel immediate.
 *
 * Each sentence is generated in its own context. A context is Cartesia's unit
 * of one continuous utterance, and closing it is what tells the service the
 * sentence is complete — so the audio for a sentence is finished as soon as
 * that sentence is, rather than waiting on the sentences behind it. The cost is
 * a possible seam between sentences, since each is shaped on its own; the
 * benefit is that the first sentence is heard without waiting for the last.
 */

import { readSamples } from "../audio/pcm.ts";
import { AIService, type ServiceConnection, type StartFrame } from "./base.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** How synthesis is configured. */
export interface CartesiaOptions {
  /** The API key. Sent in a header, never in the URL. */
  readonly apiKey: string;
  /** The voice to speak with. */
  readonly voice: string;
  /** The model to generate with. Defaults to `sonic-latest`. */
  readonly model?: string;
  /** The language to speak. Defaults to `en`. */
  readonly language?: string;
  /** The endpoint to connect to, for pointing at a proxy or a test double. */
  readonly url?: string;
}

/** The default endpoint, which tests override. */
export const CARTESIA_URL = "wss://api.cartesia.ai/tts/websocket";

/**
 * The API version to request.
 *
 * Cartesia requires it as a query parameter and uses it to pick the protocol
 * the socket speaks. Pinned rather than "latest": a new version could change
 * the message shapes this service parses.
 */
export const CARTESIA_VERSION = "2026-08-14";

/** A message from Cartesia, as far as this service reads it. */
interface CartesiaMessage {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly context_id?: unknown;
  readonly title?: unknown;
  readonly message?: unknown;
}

/** Build the connection URL for a session. */
export function cartesiaUrl(options: CartesiaOptions, base = CARTESIA_URL): string {
  const url = new URL(base);
  url.searchParams.set("cartesia_version", CARTESIA_VERSION);
  return url.toString();
}

/** Narrow a message to its fields, or `undefined` if it is not an object. */
function asMessage(message: unknown): CartesiaMessage | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  return message as CartesiaMessage;
}

/**
 * Read the audio out of a chunk message.
 *
 * The payload is base64 of raw PCM in the requested format, which for this
 * service is little-endian 16-bit mono — the format a pipeline already carries,
 * so the samples need no conversion.
 *
 * @param message The parsed message.
 * @returns The samples, or `undefined` if the message is not an audio chunk.
 */
export function readChunkData(message: unknown): Int16Array | undefined {
  const parsed = asMessage(message);
  if (parsed === undefined || parsed.type !== "chunk") {
    return undefined;
  }
  if (typeof parsed.data !== "string" || parsed.data.length === 0) {
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(parsed.data);
  } catch {
    // A payload that is not base64 is not audio, and one bad message should
    // not crash the socket handler.
    return undefined;
  }

  return readSamples(bytes, bytes.length);
}

/**
 * Read the context a message belongs to.
 *
 * Every response carries one, and it is what tells a chunk for the sentence
 * being spoken from a straggler for one that was cancelled.
 *
 * @param message The parsed message.
 * @returns The context id, or `undefined` if the message carries none.
 */
export function readContextId(message: unknown): string | undefined {
  const parsed = asMessage(message);
  if (parsed === undefined || typeof parsed.context_id !== "string") {
    return undefined;
  }
  return parsed.context_id;
}

/**
 * Read an error out of a message.
 *
 * Cartesia reports a rejected request over the open socket rather than by
 * failing the connection, so this is the only way a bad request is noticed.
 *
 * @param message The parsed message.
 * @returns The error, or `undefined` if the message is not one.
 */
export function readError(message: unknown): Error | undefined {
  const parsed = asMessage(message);
  if (parsed === undefined || parsed.type !== "error") {
    return undefined;
  }

  const title = typeof parsed.title === "string" ? parsed.title : "Cartesia error";
  const detail = typeof parsed.message === "string" ? `: ${parsed.message}` : "";
  return new Error(`${title}${detail}`);
}

export class CartesiaTTS extends AIService {
  readonly #options: CartesiaOptions;

  /** The output rate, taken from the start frame. */
  #sampleRate = 0;

  /**
   * Contexts requested but not yet finished.
   *
   * A chunk for a context not in here is a straggler from one that was
   * cancelled, and is dropped: speaking it would resurrect audio the user has
   * already talked over.
   */
  readonly #live = new Set<string>();

  /** Whether the bot is currently speaking, so the state is reported once. */
  #speaking = false;

  /**
   * @param options The API key and voice.
   * @param name A label for logs.
   */
  constructor(options: CartesiaOptions, name?: string) {
    super(name ?? "CartesiaTTS");
    this.#options = options;
  }

  protected override connect(start: StartFrame, signal: AbortSignal): Promise<ServiceConnection> {
    // Remembered for the generation requests, which are sent from `handle` and
    // so never see the start frame themselves. Set before the connection is
    // handed over, so no request can be sent before it is known.
    this.#sampleRate = start.sampleRateOut;

    return new Promise<ServiceConnection>((resolve, reject) => {
      const socket = new WebSocket(cartesiaUrl(this.#options, this.#options.url), {
        headers: { "X-API-Key": this.#options.apiKey },
      } as never);

      // Unlike Deepgram, aborting after the handshake needs no guard: the only
      // thing either listener does is close the socket, and closing an
      // already-closing socket is harmless. There is no control message here
      // that a premature close could drop.
      signal.addEventListener("abort", () => {
        socket.close();
        reject(new Error("connection aborted"));
      });

      socket.addEventListener("error", () => {
        reject(new Error("could not connect to Cartesia"));
      });

      socket.addEventListener("open", () => {
        resolve({
          send: (data) => {
            socket.send(data);
          },
          close: () => {
            socket.close();
          },
        });

        // Responses arrive unsolicited, so they are handled here rather than in
        // `process`. The socket outlives any single frame.
        socket.addEventListener("message", (event) => {
          this.#onMessage(event.data);
        });
      });
    });
  }

  protected override async handle(frame: Frame, connection: ServiceConnection): Promise<void> {
    if (frame.kind === "ttsText") {
      // A fresh context per sentence, closed as soon as the sentence is sent,
      // so Cartesia knows the sentence is complete and finishes its audio.
      const contextId = crypto.randomUUID();
      this.#live.add(contextId);

      connection.send(
        JSON.stringify({
          model_id: this.#options.model ?? "sonic-latest",
          transcript: frame.text,
          voice: this.#options.voice,
          language: this.#options.language ?? "en",
          context_id: contextId,
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: this.#sampleRate,
          },
          continue: false,
        }),
      );

      // Consumed rather than forwarded: it is an instruction to this service,
      // and nothing downstream speaks text.
      return;
    }

    this.push(frame);
  }

  /**
   * Cancel the sentences in flight.
   *
   * An interruption means the user has started talking over the reply, so the
   * audio still being generated is no longer wanted. Cancelling stops Cartesia
   * generating the rest, and clearing `#live` drops any chunk already on its
   * way — otherwise it would be played over the user's first words.
   *
   * @returns How many queued frames were dropped.
   */
  override interrupt(): number {
    const connection = this.connection;
    if (connection !== undefined) {
      for (const contextId of this.#live) {
        connection.send(JSON.stringify({ context_id: contextId, cancel: true }));
      }
    }
    this.#live.clear();

    // The bot is no longer speaking, and turn management downstream needs to
    // know that. Emitted here rather than left to the cancelled contexts'
    // `done` messages, which will not arrive.
    if (this.#speaking) {
      this.#speaking = false;
      this.push(createFrame({ kind: "botStoppedSpeaking" }));
    }

    return super.interrupt();
  }

  /** Turn one message from Cartesia into frames. */
  #onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer),
      );
    } catch {
      // A message that is not JSON is not something this service can use.
      return;
    }

    const error = readError(parsed);
    if (error !== undefined) {
      // A context that was cancelled reports an error as it winds down, which
      // is expected rather than a failure.
      const contextId = readContextId(parsed);
      if (contextId !== undefined && !this.#live.has(contextId)) {
        return;
      }
      this.fail(error);
      return;
    }

    const contextId = readContextId(parsed);
    if (contextId === undefined || !this.#live.has(contextId)) {
      // No context, or one this service is not tracking: a straggler from a
      // cancelled sentence, or a message about something else entirely.
      return;
    }

    const samples = readChunkData(parsed);
    if (samples !== undefined) {
      if (!this.#speaking) {
        this.#speaking = true;
        this.push(createFrame({ kind: "botStartedSpeaking" }));
      }
      this.push(createFrame({ kind: "ttsAudio", data: samples }));
      return;
    }

    if (asMessage(parsed)?.type === "done") {
      this.#live.delete(contextId);

      // Only once every sentence is done has the bot stopped speaking. Each
      // sentence finishes on its own, and reporting a stop between them would
      // read as the reply being over when the next sentence is still coming.
      if (this.#live.size === 0 && this.#speaking) {
        this.#speaking = false;
        this.push(createFrame({ kind: "botStoppedSpeaking" }));
      }
    }
  }
}
