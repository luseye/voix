# voix

A real-time voice agent framework in TypeScript.

`voix` streams audio through a composable pipeline — speech-to-text, a language
model, and text-to-speech — wired together as frame processors. You speak, it
answers, and the reply is spoken back.

## Try it

Needs [Bun](https://bun.sh) and one API key per provider:

| Variable | Provider | For |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | [Deepgram](https://deepgram.com) | speech recognition |
| `OPENAI_API_KEY` | [OpenAI](https://openai.com) | the language model |
| `CARTESIA_API_KEY` | [Cartesia](https://cartesia.ai) | speech synthesis |

```bash
bun install

DEEPGRAM_API_KEY=... OPENAI_API_KEY=... CARTESIA_API_KEY=... \
  bun run examples/voice-server.ts
```

Then open <http://localhost:8080> and press the button. The page is the whole
client: it captures your microphone, streams it to the server, and plays the
reply. A browser only grants microphone access on `localhost` or over HTTPS.

Set `CARTESIA_VOICE` to speak with a particular voice; without it a default is
used. `SYSTEM_PROMPT` and `PORT` are also read from the environment.

To talk over the bot and have it stop — barge-in — download a Silero VAD model
(a ~2 MB `silero_vad.onnx` from the [silero-vad repository](https://github.com/snakers4/silero-vad))
and point `SILERO_VAD_PATH` at it when starting the server.

To try the transport without any keys, `examples/echo-server.ts` sends audio
straight back:

```bash
bun run examples/echo-server.ts
wscat -c ws://localhost:8080/voice
```

## Concept

Audio, text, and control signals all travel as **frames** through a **pipeline**
of processors:

```
input ──▶ STT ──▶ aggregator ──▶ LLM ──▶ TTS ──▶ output
```

Each processor handles one frame at a time and forwards it downstream. A frame
is a discriminated union keyed on `kind`, so a case that is not handled is a
compile error rather than a surprise at runtime.

Frames are scheduled by tier. Lifecycle and control frames such as `start` and
`end` go ahead of data, so a shutdown is not stuck behind a queue of audio.
Audio, text, and speaking state keep their arrival order, because for them the
order *is* the meaning: a `transcript` that overtook the words it follows would
be recorded against the wrong turn.

Cancellation is explicit. Each stage holds an `AbortSignal` for the current turn
and another for the session; an interruption aborts the first without touching
the second, so in-flight work stops without the session going with it.

## Design goals

- **Interruptible by design.** Cancellation is explicit and propagates through
  every async operation, so a turn can be cut short without tearing down the
  session. Barge-in triggers one: confirmed user speech while the bot is
  talking, past a short echo guard, interrupts the reply.
- **Composable.** Processors are small and independent; the pipeline is just an
  ordered list.
- **Provider-agnostic.** STT, LLM, and TTS share one base class, so swapping a
  vendor means changing one file.
- **Typed end to end.** Frames are a discriminated union, so an unhandled case
  is a compile error.

## Project layout

```
src/
├── frames/       Frame type definitions
├── core/         Queue, processor base class, pipeline
├── services/     STT, LLM, and TTS integrations
├── transports/   Audio I/O (WebSocket)
└── audio/        PCM byte conversion and resampling
examples/
├── voice-server.ts    A complete voice agent
├── voice-client.*     The browser client it serves
└── echo-server.ts     The transport alone, no API key needed
```

## Using the pipeline

Assemble the stages in the order the conversation happens, and serve it:

```ts
const server = new WebSocketServer(
  { sampleRateIn: 16000, sampleRateOut: 24000 },
  (transport) =>
    new Pipeline([
      transport.input,
      new DeepgramSTT({ apiKey }),
      new UserAggregator(context),
      new OpenAILLM(context, { apiKey }),
      new SentenceAggregator(),
      new CartesiaTTS({ apiKey }),
      transport.output,
      new AssistantAggregator(context),
    ]),
);

serve(server, { port: 8080, path: "/voice" });
```

`examples/voice-server.ts` is this, runnable, plus the browser page.

## Wire protocol

A client connects to the session path and exchanges two kinds of message:

- **Binary** — raw 16-bit mono PCM, little-endian. Sample rates are converted at
  the transport boundary, so everything inside the pipeline is one format.
- **Text** — a JSON control message:

```jsonc
{ "type": "llmRun" }   // ask the pipeline to run the language model
```

## Testing

```bash
bun test
bun run typecheck
```

## Status

Early development. The pipeline runs end to end — speech in, speech out — with
voice activity detection and barge-in wired in: set `SILERO_VAD_PATH` to a
Silero model file when starting the server and talking over the bot cuts it
off. A failing service is degraded rather than fatal — it reports an `error`
frame and the session continues without it.

## License

MIT
