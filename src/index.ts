/**
 * voix — a real-time voice agent framework in TypeScript.
 *
 * The pipeline core is under construction. This entry point currently only
 * reports that the package loads correctly.
 */

export const VERSION = "0.1.0";

export * from "./audio/pcm.ts";
export * from "./audio/resample.ts";
export * from "./core/frame-processor.ts";
export * from "./core/pipeline.ts";
export * from "./core/queue.ts";
export * from "./frames/index.ts";
export * from "./services/base.ts";
export * from "./services/deepgram-stt.ts";
export * from "./transports/serve.ts";
export * from "./transports/socket.ts";
export * from "./transports/websocket-input.ts";
export * from "./transports/websocket-output.ts";
export * from "./transports/websocket-server.ts";
export * from "./transports/websocket-transport.ts";

if (import.meta.main) {
  console.log(`voix ${VERSION}`);
}
