/**
 * Barge-in decisions.
 *
 * The controller is tested in isolation: a spy records what it saw, and the
 * interrupt callback counts its calls. The clock is the only impurity, and the
 * tests that depend on it wait out the guard rather than faking time — the
 * guard is 200 ms, which no test here can afford to be wrong about twice.
 */

import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import { ECHO_GUARD_MS, TurnController } from "../src/core/turn-controller.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Records every frame it sees. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }
}

/** Waits out the echo guard, so a turn started now is interruptible. */
function afterGuard(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ECHO_GUARD_MS + 50));
}

describe("TurnController", () => {
  test("does not interrupt when the user speaks first", async () => {
    // Nothing has been said by the bot, so the user's voice is just a turn.
    let interrupts = 0;
    const spy = new Spy();
    const controller = new TurnController({ onInterrupt: () => interrupts++ });
    const pipeline = new Pipeline([controller, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toBe(0);
    expect(controller.isBotSpeaking).toBe(false);

    await pipeline.stop();
    await running;
  });

  test("does not interrupt during the echo guard", async () => {
    let interrupts = 0;
    const spy = new Spy();
    const controller = new TurnController({ onInterrupt: () => interrupts++ });
    const pipeline = new Pipeline([controller, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "botStartedSpeaking" }));
    // Deliberately not waiting out the guard: the user frame lands inside it.
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toBe(0);

    await pipeline.stop();
    await running;
  });

  test("interrupts when the user talks over the bot", async () => {
    let interrupts = 0;
    const spy = new Spy();
    const controller = new TurnController({ onInterrupt: () => interrupts++ });
    const pipeline = new Pipeline([controller, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "botStartedSpeaking" }));
    await afterGuard();
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toBe(1);
    // Interrupted once, and only once: the user is now speaking, and a second
    // user frame must not fire the callback again.
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toBe(1);

    await pipeline.stop();
    await running;
  });

  test("stops interrupting once the bot has finished", async () => {
    let interrupts = 0;
    const spy = new Spy();
    const controller = new TurnController({ onInterrupt: () => interrupts++ });
    const pipeline = new Pipeline([controller, spy]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "botStartedSpeaking" }));
    await afterGuard();
    pipeline.push(createFrame({ kind: "botStoppedSpeaking" }));
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toBe(0);
    expect(controller.isBotSpeaking).toBe(false);

    await pipeline.stop();
    await running;
  });

  test("guards against echo again for each new bot turn", async () => {
    let interrupts = 0;
    const spy = new Spy();
    const controller = new TurnController({ onInterrupt: () => interrupts++ });
    const pipeline = new Pipeline([controller, spy]);
    const running = pipeline.start(RATES);

    // First turn: interruptible after the guard.
    pipeline.push(createFrame({ kind: "botStartedSpeaking" }));
    await afterGuard();
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toBe(1);

    // A second bot turn restarts the guard, so an immediate user frame is
    // suppressed again rather than being treated as already-confirmed speech.
    pipeline.push(createFrame({ kind: "botStoppedSpeaking" }));
    pipeline.push(createFrame({ kind: "botStartedSpeaking" }));
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toBe(1);

    // And after the guard, the same voice interrupts again.
    await afterGuard();
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toBe(2);

    await pipeline.stop();
    await running;
  });

  test("the guard is measured in wall-clock milliseconds", async () => {
    // The other tests wait out the guard relative to the constant, which
    // would pass whatever its value; this one waits an absolute 250 ms —
    // past the documented 200 ms guard but well short of an order of
    // magnitude more — so widening the constant is caught.
    let interrupts = 0;
    const controller = new TurnController(
      { onInterrupt: () => interrupts++ },
      "wall-clock",
    );
    const pipeline = new Pipeline([controller]);
    const running = pipeline.start(RATES);

    pipeline.push(createFrame({ kind: "botStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toBe(1);

    await pipeline.stop();
    await running;
  });
});
