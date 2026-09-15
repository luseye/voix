/**
 * The whole pipeline, end to end.
 *
 * This is the milestone the earlier stages were built for: audio from a client
 * is transcribed, answered, spoken, and comes back as audio. Every provider is
 * a local fake, so the test needs no API key and can drive each one's replies
 * to make the conversation deterministic.
 *
 * The pipeline under test is the one the example ships — `createVoicePipeline`
 * is imported rather than reassembled here. A copy of the stage list would
 * pass while the example rotted, and the order of the stages is most of what
 * this test is checking.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { readSamples } from "../src/audio/pcm.ts";
import { LLMContext } from "../src/core/context.ts";
import { createVoicePipeline, type VoicePipelineOptions } from "../examples/voice-server.ts";
import { type ClientSocket } from "../src/transports/socket.ts";
import { WebSocketTransport } from "../src/transports/websocket-transport.ts";
import { FakeCartesia, FakeDeepgram, FakeOpenAI, until } from "./fakes.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** A socket that records everything written to it. */
class FakeSocket implements ClientSocket {
  readonly sent: (Uint8Array | string)[] = [];

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {}

  /** The samples of each audio message, decoded. */
  get audio(): Int16Array[] {
    return this.sent
      .filter((data): data is Uint8Array => typeof data !== "string")
      .map((bytes) => readSamples(bytes, bytes.length));
  }
}

/** Little-endian bytes for a run of samples, as a client would send them. */
function bytes(samples: number[]): Uint8Array {
  const buffer = new Uint8Array(samples.length * 2);
  const view = new DataView(buffer.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return buffer;
}

/** The message bodies the model was asked with, as role/content pairs. */
function conversation(openai: FakeOpenAI, index: number): [string, string][] {
  const messages = openai.bodies[index]!.messages as { role: string; content: string }[];
  return messages.map((message) => [message.role, message.content]);
}

describe("the voice pipeline", () => {
  const fakes: { stop(): void }[] = [];

  afterAll(() => {
    for (const fake of fakes) {
      fake.stop();
    }
  });

  /** A session with all three providers faked, and the socket it writes to. */
  function session(): {
    transport: WebSocketTransport;
    socket: FakeSocket;
    context: LLMContext;
    deepgram: FakeDeepgram;
    openai: FakeOpenAI;
    cartesia: FakeCartesia;
    options: VoicePipelineOptions;
  } {
    const deepgram = new FakeDeepgram();
    const openai = new FakeOpenAI();
    const cartesia = new FakeCartesia();
    fakes.push(deepgram, openai, cartesia);

    const socket = new FakeSocket();
    const transport = new WebSocketTransport(socket, {
      clientSampleRateIn: RATES.sampleRateIn,
      clientSampleRateOut: RATES.sampleRateOut,
    });
    const context = new LLMContext("Be brief.");

    return {
      transport,
      socket,
      context,
      deepgram,
      openai,
      cartesia,
      options: {
        context,
        stt: { apiKey: "k", url: deepgram.url },
        llm: { apiKey: "k", url: openai.url },
        tts: { apiKey: "k", voice: "v", url: cartesia.url },
      },
    };
  }

  test("turns a spoken turn into a spoken reply", async () => {
    const { transport, socket, deepgram, openai, cartesia, options } = session();

    // The model's reply is set before the turn that asks for it.
    openai.reply("Hi there.");

    const pipeline = createVoicePipeline(transport, options);
    const running = pipeline.start(RATES);

    // The client speaks. The bytes reach the transcriber as audio.
    transport.handleMessage(bytes([100, 200]));
    await until(() => deepgram.audio.length > 0);
    // The handshake is what a result can be sent over, and it is only up once
    // the connection has been made.
    await until(() => deepgram.authHeaders.length === 1);

    // The transcriber reports the utterance and that the speaker paused.
    deepgram.send({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "hello" }] },
    });

    // That boundary is what asks the model, with the user's words recorded.
    await until(() => openai.bodies.length === 1);
    expect(conversation(openai, 0)).toEqual([
      ["system", "Be brief."],
      ["user", "hello"],
    ]);

    // The reply is cut into a sentence and handed to synthesis.
    await until(() => cartesia.requests.length === 1);
    expect(cartesia.requests[0]!.transcript).toBe("Hi there.");

    // Synthesis returns audio, which the client receives.
    cartesia.chunk(cartesia.lastContextId, [1, 2, 3]);
    cartesia.done(cartesia.lastContextId);
    await until(() => socket.audio.length > 0);
    expect(socket.audio[0]).toEqual(Int16Array.from([1, 2, 3]));

    await pipeline.stop();
    await running;
  });

  test("records both turns, so the next request carries the conversation", async () => {
    // This is what proves the loop closes. A second turn is only answerable
    // with the first in the history, and the history is only complete if the
    // user's words and the spoken reply were both recorded — by two aggregators
    // sitting at opposite ends of the pipeline.
    const { transport, context, deepgram, openai, cartesia, options } = session();

    const pipeline = createVoicePipeline(transport, options);
    const running = pipeline.start(RATES);

    // The transcriber connects on its own task; a result sent before it has
    // would have no socket to travel over.
    await until(() => deepgram.authHeaders.length === 1);

    /** Drive one turn: the user speaks, and the reply is spoken back. */
    async function turn(heard: string, said: string, request: number): Promise<void> {
      openai.reply(said);

      deepgram.send({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: heard }] },
      });
      await until(() => openai.bodies.length === request);

      await until(() => cartesia.requests.length === request);
      cartesia.chunk(cartesia.lastContextId, [1]);
      cartesia.done(cartesia.lastContextId);
    }

    await turn("hello", "Hi there.", 1);

    // Both turns land in the history: the user's words from the aggregator on
    // the way in, the reply from the aggregator on the way out. Neither is
    // enough on its own, and the two are what the next request is built from.
    await until(() => context.length === 3);
    expect(context.getMessages()).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there." },
    ]);

    await turn("again", "Sure.", 2);

    // The second request carries the whole conversation, which is what makes
    // the reply a reply rather than an answer to a stranger.
    expect(conversation(openai, 1)).toEqual([
      ["system", "Be brief."],
      ["user", "hello"],
      ["assistant", "Hi there."],
      ["user", "again"],
    ]);

    await pipeline.stop();
    await running;
  });
});
