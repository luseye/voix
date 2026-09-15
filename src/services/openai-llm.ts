/**
 * A language model, through OpenAI's streaming chat API.
 *
 * The model is asked for the whole conversation and answers a piece at a time.
 * Each piece is forwarded as it arrives rather than collected and sent at the
 * end: speech synthesis can only start on text it has been given, so waiting
 * for the full reply would add the model's whole generation time to the delay
 * before the user hears anything.
 *
 * The request is made with the turn's signal, so an interruption cancels it.
 * That is what stops the model generating a reply nobody will hear.
 */

import { FrameProcessor } from "../core/frame-processor.ts";
import { type LLMContext } from "../core/context.ts";
import { createFrame, type Frame } from "../frames/index.ts";

/** How the model is configured. */
export interface OpenAIOptions {
  /** The API key. Sent as a bearer token, never in the URL. */
  readonly apiKey: string;
  /** The model to ask. Defaults to `gpt-4o-mini`. */
  readonly model?: string;
  /** The endpoint to call, for pointing at a proxy or a test double. */
  readonly url?: string;
}

/** The default endpoint, which tests override. */
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** A stream chunk, as far as this service reads it. */
interface OpenAIChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: unknown };
  }[];
}

/**
 * Read the text out of one stream chunk.
 *
 * A chunk carries a fragment of the reply, and some carry none at all: the
 * first announces the speaker's role, and the last reports why generation
 * stopped. Only a fragment of text is of use here.
 *
 * @param chunk The parsed chunk.
 * @returns The fragment, or `undefined` if the chunk carries no text.
 */
export function readDelta(chunk: unknown): string | undefined {
  if (typeof chunk !== "object" || chunk === null) {
    return undefined;
  }

  const content = (chunk as OpenAIChunk).choices?.[0]?.delta?.content;
  if (typeof content !== "string" || content.length === 0) {
    return undefined;
  }

  return content;
}

/**
 * Read the data payloads out of a stream of server-sent events.
 *
 * Events are separated by a blank line, and a payload may be split across two
 * network reads, so text is buffered until a separator arrives. A payload that
 * is not JSON is skipped rather than thrown: it comes from the network, and one
 * unreadable event should not abandon the rest of the reply.
 *
 * Iteration ends at `[DONE]`, which the API sends in place of a chunk to mark
 * the end of the stream.
 *
 * @param body The response body.
 * @returns Each event's payload, parsed.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // Normalised because the separator is a blank line either way, and
      // treating a carriage return as part of the payload would corrupt it.
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");

        const payload = readPayload(event);
        if (payload === undefined) {
          continue;
        }
        if (payload === "[DONE]") {
          return;
        }

        try {
          yield JSON.parse(payload);
        } catch {
          // Not JSON, so not a chunk.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Extract an event's data payload.
 *
 * An event is one or more `field: value` lines; only `data` carries the
 * payload, and every other field is a comment or metadata this does not use.
 *
 * @param event The event's text, without its trailing separator.
 * @returns The payload, or `undefined` if the event has none.
 */
function readPayload(event: string): string | undefined {
  for (const line of event.split("\n")) {
    if (line.startsWith("data:")) {
      // A single space after the colon is part of the framing, not the payload.
      return line.slice("data:".length).replace(/^ /, "");
    }
  }
  return undefined;
}

export class OpenAILLM extends FrameProcessor {
  readonly #context: LLMContext;
  readonly #options: OpenAIOptions;

  #failure: unknown;

  /**
   * @param context The conversation to send and to keep up to date.
   * @param options The API key and model.
   * @param name A label for logs.
   */
  constructor(context: LLMContext, options: OpenAIOptions, name?: string) {
    super(name ?? "OpenAILLM");
    this.#context = context;
    this.#options = options;
  }

  protected override async process(frame: Frame): Promise<void> {
    if (this.#failure !== undefined) {
      // Checked first, so a failed request stops the pipeline on the next frame
      // whatever it is — including the cancel frame that `#fail` queues to make
      // sure one arrives.
      throw this.#failure;
    }

    if (frame.kind === "llmRun") {
      // Consumed rather than forwarded: it is an instruction to this service,
      // and nothing downstream acts on it.
      //
      // The request runs on a task because it takes seconds; awaiting it here
      // would stall every frame behind it. The task gets the turn's signal, so
      // an interruption cancels the request in flight.
      this.createTask((signal) => this.#respond(signal));
      return;
    }

    this.push(frame);
  }

  /** Answer the conversation, streaming the reply out as it arrives. */
  async #respond(signal: AbortSignal): Promise<void> {
    try {
      await this.#stream(signal);
    } catch (error) {
      if (signal.aborted) {
        // Cut short by an interruption. The part already streamed was spoken
        // aloud, so it is still part of the conversation, and the end marker
        // goes out regardless to let the aggregator record it.
        this.push(createFrame({ kind: "llmTextEnded" }));
        return;
      }

      this.#fail(error);
      return;
    }

    this.push(createFrame({ kind: "llmTextEnded" }));
  }

  /** Call the API and forward each fragment of the reply. */
  async #stream(signal: AbortSignal): Promise<void> {
    const response = await fetch(this.#options.url ?? OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.#options.model ?? "gpt-4o-mini",
        // The API takes the same shape the context holds, so the history goes
        // out as it is.
        messages: this.#context.getMessages(),
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }
    if (response.body === null) {
      throw new Error("OpenAI returned no response body");
    }

    for await (const chunk of readSse(response.body)) {
      const text = readDelta(chunk);
      if (text !== undefined) {
        this.push(createFrame({ kind: "llmText", text }));
      }
    }
  }

  /**
   * Record a failure and stop the pipeline.
   *
   * A model that cannot be reached leaves nothing to say, and a stage that
   * silently produces no reply is worse than one that stops: the session would
   * sit waiting for words that are never coming.
   */
  #fail(error: unknown): void {
    this.#failure = error;

    // Wake the loop so it observes the failure. The `llmRun` that triggered
    // this request has already been consumed, so nothing else will.
    try {
      this.enqueue(createFrame({ kind: "cancel" }));
    } catch {
      // Already stopped, so the failure has nowhere left to go.
    }
  }
}
