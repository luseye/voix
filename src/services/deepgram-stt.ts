/**
 * Speech recognition through Deepgram's streaming API.
 *
 * Audio is already 16-bit mono PCM inside a pipeline, which is one of the
 * encodings Deepgram accepts, so frames are sent as they arrive and the
 * service reports each transcript it gets back.
 *
 * A transcript arrives twice: once as an interim result that is likely to
 * change, and again as a final one when Deepgram is done with that stretch of
 * speech. Both are forwarded, with `final` distinguishing them, because an
 * interim result is what lets a reply start before the user has stopped
 * talking.
 */

import { writeSamples } from "../audio/pcm.ts";
import { AIService, type ServiceConnection, type StartFrame } from "./base.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** How a Deepgram connection is configured. */
export interface DeepgramOptions {
  /** The API key. Sent as a bearer token, never in the URL. */
  readonly apiKey: string;
  /** The model to transcribe with. Defaults to `nova-3`. */
  readonly model?: string;
  /** The language of the audio. Defaults to `en`. */
  readonly language?: string;
  /** The endpoint to connect to, for pointing at a proxy or a test double. */
  readonly url?: string;
}

/** The default endpoint, which tests override. */
export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

/** A result message, as far as this service reads it. */
interface DeepgramResult {
  readonly type?: unknown;
  readonly is_final?: unknown;
  readonly channel?: {
    readonly alternatives?: readonly { readonly transcript?: unknown }[];
  };
}

/**
 * Read the transcript out of a result message.
 *
 * Deepgram sends other message types on the same socket — metadata, speech
 * events — and a message is only useful here if it carries text. Everything is
 * checked rather than trusted: the payload comes from the network, and a
 * malformed one should be ignored rather than crash the pipeline.
 *
 * @param message The parsed message.
 * @returns The transcript and whether it is final, or `undefined` if the
 *   message carries no text.
 */
export function readTranscript(
  message: unknown,
): { readonly text: string; readonly final: boolean } | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }

  const result = message as DeepgramResult;
  if (result.type !== "Results") {
    return undefined;
  }

  const transcript = result.channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string" || transcript.length === 0) {
    // An interim result with nothing recognised yet is sent as an empty
    // string, which is not something downstream can use.
    return undefined;
  }

  return { text: transcript, final: result.is_final === true };
}

/** Build the connection URL for a session. */
export function deepgramUrl(
  options: DeepgramOptions,
  sampleRate: number,
  base = DEEPGRAM_URL,
): string {
  const url = new URL(base);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(sampleRate));
  // Audio inside a pipeline is always mono.
  url.searchParams.set("channels", "1");
  url.searchParams.set("model", options.model ?? "nova-3");
  url.searchParams.set("language", options.language ?? "en");
  // Without this, nothing is reported until the whole utterance is done, so a
  // reply could not start until the user had stopped talking.
  url.searchParams.set("interim_results", "true");
  return url.toString();
}

export class DeepgramSTT extends AIService {
  readonly #options: DeepgramOptions;

  /**
   * @param options The API key and model.
   * @param name A label for logs.
   */
  constructor(options: DeepgramOptions, name?: string) {
    super(name ?? "DeepgramSTT");
    this.#options = options;
  }

  protected override connect(start: StartFrame, signal: AbortSignal): Promise<ServiceConnection> {
    const url = deepgramUrl(this.#options, start.sampleRateIn, this.#options.url);

    return new Promise<ServiceConnection>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Token ${this.#options.apiKey}` },
      } as never);

      // Whether the handshake has finished. Until it has, aborting has to close
      // the socket here, or a handshake that never completes would leave the
      // pipeline unable to shut down. Once it has, the listener `AIService`
      // registers on the same signal owns the close, and it is the graceful
      // one: sending `CloseStream` first. Closing the raw socket here instead
      // would win the race — this listener is registered first — and the
      // control message would be dropped on a socket already shutting down.
      let open = false;

      signal.addEventListener("abort", () => {
        if (open) {
          return;
        }
        socket.close();
        reject(new Error("connection aborted"));
      });

      socket.addEventListener("error", () => {
        reject(new Error("could not connect to Deepgram"));
      });

      socket.addEventListener("open", () => {
        open = true;

        resolve({
          send: (data) => {
            // Deepgram takes audio as binary and control messages as text.
            socket.send(data);
          },
          close: () => {
            // Telling Deepgram the stream has ended lets it finish transcribing
            // what it already has, rather than dropping it with the socket.
            socket.send(JSON.stringify({ type: "CloseStream" }));
            socket.close();
          },
        });

        // Results arrive unsolicited, so they are handled here rather than in
        // `process`. The socket outlives any single frame.
        socket.addEventListener("message", (event) => {
          this.#onMessage(event.data);
        });
      });
    });
  }

  protected override async handle(frame: Frame, connection: ServiceConnection): Promise<void> {
    if (frame.kind === "inputAudio") {
      // Deepgram takes little-endian 16-bit PCM, which is the wire format the
      // transport already defined.
      connection.send(writeSamples(frame.data));
      return;
    }

    // Every other frame is passed along untouched: this service recognises
    // speech, and has no business consuming anything else.
    this.push(frame);
  }

  /** Turn one message from Deepgram into a transcript frame. */
  #onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      // A message that is not JSON is not a transcript.
      return;
    }

    const result = readTranscript(parsed);
    if (result === undefined) {
      return;
    }

    this.push(createFrame({ kind: "transcript", text: result.text, final: result.final }));
  }
}
