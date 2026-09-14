import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { QueueClosedError } from "../src/core/queue.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

/** Records every frame it sees, then forwards it downstream. */
class Stage extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
    this.push(frame);
  }

  /** The kinds of the frames seen, in order. */
  get kinds(): string[] {
    return this.seen.map((frame) => frame.kind);
  }
}

/** Holds its first frame until released, so later frames queue behind it. */
class Holding extends Stage {
  holding = false;
  #release: () => void = () => {};
  #held: Promise<void> | undefined;

  protected override async process(frame: Frame): Promise<void> {
    if (this.#held === undefined) {
      this.#held = new Promise<void>((resolve) => {
        this.#release = resolve;
      });
      this.holding = true;
      await this.#held;
    }

    await super.process(frame);
  }

  release(): void {
    this.#release();
  }
}

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Waits until a condition holds, so tests do not depend on timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was never met");
}

describe("Pipeline", () => {
  test("links the processors in order", () => {
    const first = new Stage("first");
    const second = new Stage("second");
    const third = new Stage("third");

    const pipeline = new Pipeline([first, second, third]);

    expect(pipeline.processors).toEqual([first, second, third]);
    expect(pipeline.head).toBe(first);
    expect(pipeline.tail).toBe(third);
    expect(first.next).toBe(second);
    expect(second.next).toBe(third);
    expect(third.prev).toBe(second);
  });

  test("leaves the ends of the chain open", () => {
    const pipeline = new Pipeline([new Stage("first"), new Stage("second")]);

    expect(pipeline.head.prev).toBeUndefined();
    expect(pipeline.tail.next).toBeUndefined();
  });

  test("rejects an empty pipeline", () => {
    expect(() => new Pipeline([])).toThrow("at least one processor");
  });

  test("copies the processor list", () => {
    const stages = [new Stage("first"), new Stage("second")];
    const pipeline = new Pipeline(stages);

    stages.pop();

    expect(pipeline.processors).toHaveLength(2);
  });

  describe("start", () => {
    test("delivers the start frame to every stage", async () => {
      const first = new Stage("first");
      const second = new Stage("second");
      const third = new Stage("third");
      const pipeline = new Pipeline([first, second, third]);

      // Awaiting one loop before starting the next would deadlock here: the
      // start frame would reach the head before anything downstream ran.
      const running = pipeline.start(RATES);
      expect(pipeline.isRunning).toBe(true);
      await pipeline.stop();
      await running;

      for (const stage of [first, second, third]) {
        expect(stage.seen[0]).toMatchObject({ kind: "start", ...RATES });
        expect(stage.kinds).toEqual(["start", "end"]);
      }
      expect(pipeline.isRunning).toBe(false);
    });

    test("rejects a second start", async () => {
      const pipeline = new Pipeline([new Stage("only")]);
      const running = pipeline.start(RATES);

      expect(() => pipeline.start(RATES)).toThrow("already been started");

      await pipeline.stop();
      await running;
    });

    test("stops the other stages when one fails", async () => {
      class Failing extends Stage {
        protected override async process(frame: Frame): Promise<void> {
          this.seen.push(frame);
          throw new Error("boom");
        }
      }

      const healthy = new Stage("healthy");
      const failing = new Failing("failing");
      const pipeline = new Pipeline([healthy, failing]);

      await expect(pipeline.start(RATES)).rejects.toThrow("boom");
      // The healthy stage would otherwise wait for frames that never arrive.
      expect(healthy.isRunning).toBe(false);
      expect(failing.isRunning).toBe(false);
    });
  });

  describe("push", () => {
    test("injects a frame at the head", async () => {
      const first = new Stage("first");
      const second = new Stage("second");
      const pipeline = new Pipeline([first, second]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "llmRun" }));
      // The end frame outranks a data frame, so wait for delivery before
      // stopping; otherwise the stop overtakes it and it is dropped.
      await until(() => second.seen.length === 2);
      await pipeline.stop();
      await running;

      expect(first.kinds).toEqual(["start", "llmRun", "end"]);
      expect(second.kinds).toEqual(["start", "llmRun", "end"]);
    });

    test("drops a data frame that a stop overtakes", async () => {
      const first = new Holding("first");
      const second = new Stage("second");
      const pipeline = new Pipeline([first, second]);
      const running = pipeline.start(RATES);
      await until(() => first.holding);

      // Both frames queue while the first stage is held, so the end frame's
      // higher tier decides the order rather than arrival.
      pipeline.push(createFrame({ kind: "llmRun" }));
      const stopping = pipeline.stop();
      first.release();
      await stopping;
      await running;

      expect(first.kinds).toEqual(["start", "end", "llmRun"]);
      // The end frame closed this stage before the data frame could arrive, so
      // forwarding it downstream reports a dropped frame rather than throwing.
      expect(second.kinds).toEqual(["start", "end"]);
    });

    test("refuses a frame once stopped", async () => {
      const pipeline = new Pipeline([new Stage("only")]);
      const running = pipeline.start(RATES);
      await pipeline.stop();
      await running;

      expect(() => pipeline.push(createFrame({ kind: "llmRun" }))).toThrow(QueueClosedError);
    });
  });

  describe("interrupt", () => {
    test("aborts the work of every stage", async () => {
      const first = new Stage("first");
      const second = new Stage("second");
      const pipeline = new Pipeline([first, second]);
      const running = pipeline.start(RATES);

      const signals = [first.signal, second.signal];
      pipeline.interrupt();

      // Visiting the stages directly is what makes this total: no stage can be
      // skipped because a broadcast frame failed to reach it.
      for (const signal of signals) {
        expect(signal.aborted).toBe(true);
      }

      await pipeline.stop();
      await running;
    });

    test("leaves session-scoped work running", async () => {
      const first = new Stage("first");
      const second = new Stage("second");
      const pipeline = new Pipeline([first, second]);
      const running = pipeline.start(RATES);

      // A transcription connection spans the session, so the interruption it
      // reported must not be what closes it.
      pipeline.interrupt();

      expect(first.sessionSignal.aborted).toBe(false);
      expect(second.sessionSignal.aborted).toBe(false);

      await pipeline.stop();
      await running;
    });

    test("totals the frames dropped across the stages", async () => {
      const first = new Holding("first");
      const pipeline = new Pipeline([first, new Stage("second")]);
      const running = pipeline.start(RATES);
      await until(() => first.holding);

      // Queued behind the held frame, so there is something to drop.
      pipeline.push(createFrame({ kind: "llmText", text: "one" }));
      pipeline.push(createFrame({ kind: "llmText", text: "two" }));
      await until(() => first.queueSize === 2);

      expect(pipeline.interrupt()).toBe(2);
      expect(first.queueSize).toBe(0);

      first.release();
      await pipeline.stop();
      await running;
    });
  });

  describe("stop", () => {
    test("rejects when the pipeline was never started", async () => {
      const pipeline = new Pipeline([new Stage("only")]);

      await expect(pipeline.stop()).rejects.toThrow("has not been started");
    });

    test("is safe to call twice", async () => {
      const pipeline = new Pipeline([new Stage("only")]);
      const running = pipeline.start(RATES);

      await pipeline.stop();
      await pipeline.stop();
      await running;

      expect(pipeline.isRunning).toBe(false);
    });
  });
});
