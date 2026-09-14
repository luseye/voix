import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

/** A processor that records the frames it sees and does nothing else. */
class Sink extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }
}

/** Waits until a condition holds, so tests do not depend on timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was never met");
}

/** A promise with its resolve exposed. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A task that resolves only once its signal aborts, and records that it did. */
function abortable(record: { aborted: boolean }) {
  return (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        record.aborted = true;
        resolve();
      });
    });
}

describe("FrameProcessor", () => {
  describe("createTask", () => {
    test("runs the task, passing a signal, and returns its result", async () => {
      const sink = new Sink("sink");

      const aborted = await sink.createTask(async (signal) => signal.aborted);

      expect(aborted).toBe(false);
    });

    test("does not block the loop while the task runs", async () => {
      const sink = new Sink("sink");
      const gate = deferred();
      sink.createTask(() => gate.promise);

      // A task runs alongside the loop, so frames keep being handled.
      const running = sink.run();
      sink.enqueue(createFrame({ kind: "llmRun" }));
      await until(() => sink.seen.length === 1);

      gate.resolve();
      sink.close();
      await running;
    });
  });

  describe("interrupt", () => {
    test("aborts the signal of in-flight tasks", async () => {
      const sink = new Sink("sink");
      const record = { aborted: false };
      sink.createTask(abortable(record));

      sink.interrupt();

      await until(() => record.aborted);
      expect(record.aborted).toBe(true);
    });

    test("gives tasks started afterwards a fresh signal", () => {
      const sink = new Sink("sink");
      const before = sink.signal;

      sink.interrupt();

      expect(before.aborted).toBe(true);
      expect(sink.signal.aborted).toBe(false);
      expect(sink.signal).not.toBe(before);
    });

    test("drops queued data frames", () => {
      const sink = new Sink("sink");
      sink.enqueue(createFrame({ kind: "inputAudio", data: new Int16Array(0) }));
      sink.enqueue(createFrame({ kind: "llmText", text: "hi" }));
      sink.enqueue(createFrame({ kind: "ttsAudio", data: new Int16Array(0) }));

      expect(sink.interrupt()).toBe(3);
      expect(sink.queueSize).toBe(0);
    });

    test("keeps queued lifecycle and speaking state frames", async () => {
      const sink = new Sink("sink");
      sink.enqueue(createFrame({ kind: "userStartedSpeaking" }));
      sink.enqueue(createFrame({ kind: "llmText", text: "hi" }));
      sink.enqueue(createFrame({ kind: "end" }));

      expect(sink.interrupt()).toBe(1);

      // A turn's state frames outlive the turn: the pipeline still has to know
      // that the user is speaking, and still has to be stoppable.
      await sink.run();
      expect(sink.seen.map((frame) => frame.kind)).toEqual(["userStartedSpeaking", "end"]);
    });

    test("leaves the frame being handled alone", async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;

      class Holding extends Sink {
        protected override async process(frame: Frame): Promise<void> {
          entered = true;
          await held;
          await super.process(frame);
        }
      }

      const sink = new Holding("sink");
      sink.enqueue(createFrame({ kind: "llmText", text: "first" }));
      const running = sink.run();
      await until(() => entered);

      sink.enqueue(createFrame({ kind: "llmText", text: "second" }));
      expect(sink.interrupt()).toBe(1);

      release();
      sink.close();
      await running;

      // The frame in flight is no longer queued, so it runs to completion.
      expect(sink.seen).toHaveLength(1);
      expect(sink.seen[0]).toMatchObject({ kind: "llmText", text: "first" });
    });
  });

  describe("shutdown", () => {
    test("aborts in-flight tasks and waits for them", async () => {
      const sink = new Sink("sink");
      const record = { aborted: false };
      sink.createTask(abortable(record));

      const running = sink.run();
      sink.close();

      // The task resolves only from its abort handler, so a loop that returned
      // without waiting would settle before the handler ran.
      await running;
      expect(record.aborted).toBe(true);
    });

    test("does not settle while a task is still running", async () => {
      const sink = new Sink("sink");
      const gate = deferred();
      sink.createTask(() => gate.promise);

      const running = sink.run();
      sink.close();
      let settled = false;
      void running.then(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(settled).toBe(false);

      gate.resolve();
      await running;
      expect(settled).toBe(true);
    });

    test("is not derailed by a failing task, reported or ignored", async () => {
      const reported: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        reported.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const sink = new Sink("sink");
        // Started and never awaited, the usual way a long-lived task is used.
        sink.createTask(async () => {
          throw new Error("ignored failure");
        });
        await new Promise((resolve) => setTimeout(resolve, 5));

        const running = sink.run();
        sink.close();
        await running;

        expect(sink.isRunning).toBe(false);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      expect(reported).toEqual([]);
    });
  });
});
