# voix

A real-time voice agent framework in TypeScript.

`voix` streams audio through a composable pipeline: speech-to-text, a language
model, and text-to-speech, wired together as frame processors. Interruptions —
the user talking over the bot — are a first-class part of the design, not a
feature bolted on afterwards.

> **Status:** early development. The core pipeline is being built in stages.

## Concept

Audio, text, and control signals all travel as **frames** through a **pipeline**
of processors:

```
input ──▶ STT ──▶ aggregator ──▶ LLM ──▶ TTS ──▶ output
```

Each processor handles one frame at a time and forwards it downstream. Frames
can also travel upstream to report errors and acknowledgements. When the user
starts speaking, an interruption frame is broadcast in both directions, which
cancels in-flight work — an LLM request, a TTS stream — through a shared
`AbortSignal`.

## Design goals

- **Interruptible by default.** Cancellation is explicit and propagates through
  every async operation.
- **Composable.** Processors are small and independent; the pipeline is just an
  ordered list.
- **Provider-agnostic.** STT, LLM, and TTS sit behind interfaces, so swapping a
  vendor means changing one file.
- **Typed end to end.** Frames are a discriminated union, so an unhandled case
  is a compile error.

## Requirements

- [Bun](https://bun.sh) (runtime, package manager, and test runner)

## Getting started

```bash
bun install
```

## Project layout

```
src/
├── frames/       Frame type definitions
├── core/         Queue, processor base class, pipeline
├── services/     STT, LLM, and TTS integrations
├── transports/   Audio I/O (WebSocket)
└── audio/        Voice activity detection, resampling
```

## Testing

```bash
bun test
```

## License

MIT
