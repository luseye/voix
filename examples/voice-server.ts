/**
 * A runnable voice agent.
 *
 * The pipeline is the whole framework in one place: the client's audio is
 * transcribed, recorded as the user's turn, answered by a model, cut into
 * sentences, spoken, and finally recorded as the assistant's turn. Everything
 * before this example exercised one stage at a time; this is the shape they
 * were built to make.
 *
 * The assembly is exported so it can be tested against fake providers, which
 * is what keeps the order below from drifting: the stages are linked in the
 * order they appear, and several of them only work in that order.
 *
 * Run it with the keys in the environment:
 *
 * ```bash
 * DEEPGRAM_API_KEY=... OPENAI_API_KEY=... CARTESIA_API_KEY=... \
 *   bun run examples/voice-server.ts
 * ```
 *
 * Set `CARTESIA_VOICE` to speak with a particular voice; without it the service
 * uses its own default.
 *
 * Then open `http://localhost:8080` and press the button: the page serves the
 * browser client, which streams microphone audio and plays what comes back.
 * The console prints what the pipeline is doing.
 */

import { UserAggregator, AssistantAggregator } from "../src/core/aggregators.ts";
import { LLMContext } from "../src/core/context.ts";
import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { SentenceAggregator } from "../src/core/sentence-aggregator.ts";
import { TurnController } from "../src/core/turn-controller.ts";
import { type Frame } from "../src/frames/index.ts";
import { SileroVAD } from "../src/audio/silero.ts";
import { VADProcessor } from "../src/audio/vad.ts";
import { CartesiaTTS, type CartesiaOptions } from "../src/services/cartesia-tts.ts";
import { DeepgramSTT, type DeepgramOptions } from "../src/services/deepgram-stt.ts";
import { OpenAILLM, type OpenAIOptions } from "../src/services/openai-llm.ts";
import { serve } from "../src/transports/serve.ts";
import { WebSocketServer } from "../src/transports/websocket-server.ts";
import { type WebSocketTransport } from "../src/transports/websocket-transport.ts";
import page from "./voice-client.html";

/** How the pipeline's providers are configured. */
export interface VoicePipelineOptions {
  /**
   * The conversation the session records into.
   *
   * Owned by the caller rather than created here, because it outlives the
   * pipeline in every way that matters: it can be persisted, inspected, or
   * reset between sessions, and a caller that wants any of that needs the
   * reference.
   */
  readonly context: LLMContext;
  readonly stt: DeepgramOptions;
  readonly llm: OpenAIOptions;
  readonly tts: CartesiaOptions;
  /**
   * A loaded voice activity detector, for barge-in.
   *
   * Optional: without it there is no barge-in, and turn ends come only from
   * Deepgram's endpointing, as before. It is given ready-made rather than
   * assembled here because loading the model is asynchronous and this
   * assembler is deliberately synchronous — the caller awaits `SileroVAD`
   * once, at startup, where a failure should stop the process anyway.
   */
  readonly vad?: VADProcessor;
  /** Whether to print the frames the session handles. Defaults to `false`. */
  readonly log?: boolean;
}

/**
 * Assemble the stages for one session.
 *
 * The order is the conversation's order, and it is not interchangeable:
 *
 * - The aggregators sit at opposite ends. The user's words are collected
 *   before the model runs, and the model's reply is collected after it has been
 *   spoken, so that only what was actually said is recorded.
 * - The sentence aggregator sits between the model and synthesis, turning a
 *   stream of fragments into whole sentences to speak.
 * - Synthesis comes before the transport's output, which converts its audio
 *   for the client. The assistant aggregator is last. It only observes — it
 *   records the reply and forwards it on — so its position relative to the
 *   output does not change what either does, and it is kept at the tail because
 *   that is where the conversation's end is.
 *
 * A fresh context per session is what keeps conversations apart: two clients
 * are two conversations, and a shared history would have each model answering
 * the other's user. The context comes from the caller for that reason.
 *
 * @param transport The connection's two ends.
 * @param options The context and the providers.
 * @returns The pipeline, not yet started.
 */
export function createVoicePipeline(
  transport: WebSocketTransport,
  options: VoicePipelineOptions,
): Pipeline {
  const context = options.context;

  const vad = options.vad;
  const turnController = new TurnController({ onInterrupt: () => pipeline.interrupt() });

  const stages: FrameProcessor[] = [
    transport.input,
    // The VAD rides ahead of recognition: it only observes the audio and
    // forwards it, and it has to see the user's voice before anything else
    // decides the turn is over. It is where barge-in gets its signal.
    ...(vad === undefined ? [] : [vad]),
    new DeepgramSTT(options.stt),
    new UserAggregator(context),
    new OpenAILLM(context, options.llm),
    new SentenceAggregator(),
    new CartesiaTTS(options.tts),
    transport.output,
    new AssistantAggregator(context),
    // The controller sits at the tail, where every speaking-state frame has
    // already passed: the bot's state from Cartesia, the user's from the VAD.
    // It observes and forwards, so its position changes nothing downstream.
    turnController,
  ];

  if (options.log === true) {
    // Last, so it sees every frame that reached the end of the pipeline. It
    // observes and forwards, so its position does not change what the stages
    // before it do.
    stages.push(new Log("log"));
  }

  const pipeline = new Pipeline(stages);
  return pipeline;
}

/** Prints what it sees, so a session is visible from the console. */
class Log extends FrameProcessor {
  protected override async process(frame: Frame): Promise<void> {
    // Audio is the bulk of the traffic and says nothing on its own, so only
    // the frames that carry meaning are printed.
    if (frame.kind !== "inputAudio" && frame.kind !== "ttsAudio") {
      console.log(`[${this.name}] ${frame.kind}`);
    }
    this.push(frame);
  }
}

/** Read a key from the environment, failing loudly when it is missing. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Set ${name} before running the voice server`);
  }
  return value;
}

/** Read an optional setting, treating an empty value as unset. */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

if (import.meta.main) {
  const PORT = Number(process.env.PORT ?? 8080);
  const systemPrompt =
    process.env.SYSTEM_PROMPT ??
    "You are a helpful voice assistant. Answer briefly and in plain sentences.";

  // Barge-in is enabled by pointing SILERO_VAD_PATH at a Silero model file,
  // downloaded from the silero-vad repository. The model is loaded once, at
  // startup, and shared by every session: it is read-only state per window,
  // and the VAD processor a session gets carries its own recurrent buffer.
  const modelPath = optionalEnv("SILERO_VAD_PATH");
  const silero = modelPath === undefined ? undefined : await SileroVAD.create({ modelPath });

  const server = new WebSocketServer({ sampleRateIn: 16000, sampleRateOut: 24000 }, (transport) => {
    // A fresh context per connection, so each client is its own conversation.
    return createVoicePipeline(transport, {
      context: new LLMContext(systemPrompt),
      stt: { apiKey: requireEnv("DEEPGRAM_API_KEY") },
      llm: { apiKey: requireEnv("OPENAI_API_KEY") },
      tts: {
        apiKey: requireEnv("CARTESIA_API_KEY"),
        // Optional: without it the service falls back to its own default
        // voice, so running the example needs only the three keys.
        voice: optionalEnv("CARTESIA_VOICE"),
      },
      vad: silero === undefined ? undefined : new VADProcessor({ source: silero }),
      log: true,
    });
  });

  // The page is served at the root and the session at `/voice`, so opening
  // `http://localhost:PORT` in a browser is the whole client. A microphone
  // needs a secure context, which `http://localhost` counts as.
  serve(server, { port: PORT, path: "/voice", page });
  console.log(`open http://localhost:${PORT} and press the button`);
}
