/**
 * voix — a real-time voice agent framework in TypeScript.
 *
 * The pipeline core is under construction. This entry point currently only
 * reports that the package loads correctly.
 */

export const VERSION = "0.1.0";

export * from "./core/frame-processor.ts";
export * from "./core/pipeline.ts";
export * from "./core/queue.ts";
export * from "./frames/index.ts";

if (import.meta.main) {
  console.log(`voix ${VERSION}`);
}
