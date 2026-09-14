/**
 * A runnable transport demo.
 *
 * The pipeline is just the transport's two ends, so anything a client sends
 * comes straight back at the client's own rate. It exercises the parts that
 * do not need an API key: byte order, resampling, control messages, and
 * connection lifecycle.
 *
 * Run it with:
 *
 * ```bash
 * bun run examples/echo-server.ts
 * ```
 *
 * Then connect and send some bytes:
 *
 * ```bash
 * wscat -c ws://localhost:8080/voice
 * ```
 */

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import { serve } from "../src/transports/serve.ts";
import { WebSocketServer } from "../src/transports/websocket-server.ts";

/** Prints what it sees, so a connected client is visible from the console. */
class Log extends FrameProcessor {
  protected override async process(frame: Frame): Promise<void> {
    console.log(`[${this.name}] ${frame.kind}`);
    this.push(frame);
  }
}

/**
 * Turns incoming audio into audio the transport will send back.
 *
 * The two are different frames — `inputAudio` arrives from the client and
 * `ttsAudio` is what the output side writes — so echoing needs this hop. A
 * real pipeline replaces it with speech recognition and synthesis.
 */
class Echo extends FrameProcessor {
  protected override async process(frame: Frame): Promise<void> {
    if (frame.kind === "inputAudio") {
      this.push(createFrame({ kind: "ttsAudio", data: frame.data }));
      return;
    }
    this.push(frame);
  }
}

const PORT = Number(process.env.PORT ?? 8080);

const server = new WebSocketServer(
  { sampleRateIn: 16000, sampleRateOut: 24000 },
  (transport) =>
    new Pipeline([transport.input, new Log("log"), new Echo("echo"), transport.output]),
);

serve(server, { port: PORT, path: "/voice" });
console.log(`listening on ws://localhost:${PORT}/voice`);
