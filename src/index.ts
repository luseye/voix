/**
 * voix — a real-time voice agent framework in TypeScript.
 *
 * The pipeline core is under construction. This entry point currently only
 * reports that the package loads correctly.
 */

export const VERSION = "0.1.0";

if (import.meta.main) {
  console.log(`voix ${VERSION}`);
}
