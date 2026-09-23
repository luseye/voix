import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import {
  AIService,
  type ServiceConnection,
  type StartFrame,
} from "../src/services/base.ts";

const RATES = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** A connection that records what it was sent and whether it closed. */
class FakeConnection implements ServiceConnection {
  readonly sent: (Uint8Array | string)[] = [];
  closed = false;

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

/** A service that records the frames it handles once connected. */
class TestService extends AIService {
  readonly fake = new FakeConnection();
  readonly handled: Frame[] = [];
  /** The start frame the connection was built from, for asserting on rates. */
  started: StartFrame | undefined;
  /** How long `handle` takes, to open a window in which a frame can arrive. */
  #delay: number;
  #connect: (start: StartFrame, signal: AbortSignal) => Promise<ServiceConnection>;
  /**
   * An optional behaviour to run instead of the default `handle`, set from
   * tests that need one frame to fail. Returning without throwing keeps the
   * default behaviour.
   */
  overrideHandle: ((frame: Frame, connection: ServiceConnection) => Promise<void>) | undefined;

  constructor(
    connect?: (start: StartFrame, signal: AbortSignal) => Promise<ServiceConnection>,
    delay = 0,
  ) {
    super("service");
    this.#connect = connect ?? (async () => this.fake);
    this.#delay = delay;
  }

  protected override connect(start: StartFrame, signal: AbortSignal): Promise<ServiceConnection> {
    this.started = start;
    return this.#connect(start, signal);
  }

  protected override async handle(frame: Frame, connection: ServiceConnection): Promise<void> {
    if (this.overrideHandle !== undefined) {
      await this.overrideHandle(frame, connection);
      return;
    }

    if (this.#delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delay));
    }
    this.handled.push(frame);
    connection.send(frame.kind);
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
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A connection that opens only when told to, and gives up when aborted.
 *
 * A real handshake is abortable — `fetch` and a WebSocket both take the signal
 * — and shutdown depends on that: it waits for the task, so a handshake that
 * ignored the signal would hang the stop.
 */
function gatedConnection(connection: ServiceConnection) {
  const gate = deferred<ServiceConnection>();
  let started = false;

  const connect = (start: StartFrame, signal: AbortSignal): Promise<ServiceConnection> => {
    started = true;
    return new Promise<ServiceConnection>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      void gate.promise.then(resolve);
    });
  };

  return { connect, gate, started: () => started };
}

describe("AIService", () => {
  describe("lifecycle", () => {
    test("opens the connection when the start frame arrives", async () => {
      const service = new TestService();
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);

      // The start frame is consumed by `connect`, not `handle`: the connection
      // is built from it, and handing it on would forward it twice.
      await until(() => service.started !== undefined);
      expect(service.started).toMatchObject({ sampleRateIn: 16000, sampleRateOut: 24000 });
      expect(service.handled).toHaveLength(0);

      await pipeline.stop();
      await running;
    });

    test("forwards the start frame downstream exactly once", async () => {
      const service = new TestService();
      const seen: Frame[] = [];

      class Sink extends FrameProcessor {
        protected override async process(frame: Frame): Promise<void> {
          seen.push(frame);
        }
      }

      const sink = new Sink("sink");
      const pipeline = new Pipeline([service, sink]);
      const running = pipeline.start(RATES);

      // A later stage opens its own connection from the rates, so the start
      // frame has to keep travelling — and only once, since `connect` already
      // received it and forwarding it twice would duplicate it downstream.
      await until(() => seen.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(seen.map((frame) => frame.kind)).toEqual(["start"]);

      await pipeline.stop();
      await running;
    });

    test("closes the connection on shutdown", async () => {
      const service = new TestService();
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);
      await until(() => service.started !== undefined);

      await pipeline.stop();
      await running;

      expect(service.fake.closed).toBe(true);
    });

    test("keeps the connection open across an interruption", async () => {
      const service = new TestService();
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);
      await until(() => service.started !== undefined);

      // A transcription connection spans the session, so the interruption it
      // reported must not be what closes it.
      pipeline.interrupt();
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(service.fake.closed).toBe(false);

      await pipeline.stop();
      await running;
      expect(service.fake.closed).toBe(true);
    });
  });

  describe("frames before the connection is open", () => {
    test("holds them and delivers them in order once it opens", async () => {
      const connection = new FakeConnection();
      const gated = gatedConnection(connection);
      const service = new TestService(gated.connect);
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);
      await until(() => service.queueSize === 0 && gated.started());

      // These arrive while the handshake is still running.
      pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([1]) }));
      pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([2]) }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(service.handled).toHaveLength(0);

      gated.gate.resolve(connection);
      await until(() => service.handled.length === 2);

      expect(service.handled.map((frame) => frame.kind)).toEqual([
        "inputAudio",
        "inputAudio",
      ]);

      await pipeline.stop();
      await running;
    });

    test("does not let a later frame overtake the held ones", async () => {
      const connection = new FakeConnection();
      const gated = gatedConnection(connection);
      const service = new TestService(gated.connect);
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([1]) }));
      await until(() => service.queueSize === 0 && gated.started());

      // Delivering the backlog takes more than one turn of the loop, so a
      // frame arriving during it must not be handled ahead of the backlog.
      gated.gate.resolve(connection);
      pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([2]) }));
      await until(() => service.handled.length === 2);

      const audio = service.handled.filter((frame) => frame.kind === "inputAudio");
      expect((audio[0] as { data: Int16Array }).data).toEqual(Int16Array.from([1]));
      expect((audio[1] as { data: Int16Array }).data).toEqual(Int16Array.from([2]));

      await pipeline.stop();
      await running;
    });

    test("drops held frames when the session ends first", async () => {
      const gated = gatedConnection(new FakeConnection());
      const service = new TestService(gated.connect);
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([1]) }));
      await until(() => service.queueSize === 0 && gated.started());

      // Shutdown aborts the handshake, so the held audio is dropped rather
      // than delivered to a connection that is about to close.
      await pipeline.stop();
      await running;

      expect(service.handled).toHaveLength(0);
    });

    test("stops delivering the backlog when the session ends mid-drain", async () => {
      // A slow handshake lets frames pile up, and a slow `handle` makes the
      // drain take more than one turn of the loop. The end frame then arrives
      // while the backlog is still being delivered.
      const connection = new FakeConnection();
      const slowConnect = async (
        _start: StartFrame,
        signal: AbortSignal,
      ): Promise<ServiceConnection> => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return connection;
      };

      const service = new TestService(slowConnect, 3);
      const pipeline = new Pipeline([service]);
      const running = pipeline.start(RATES);

      for (let i = 0; i < 20; i++) {
        pipeline.push(createFrame({ kind: "inputAudio", data: Int16Array.from([i]) }));
      }
      // Mid-drain: the handshake is done and the backlog is being delivered.
      await until(() => service.handled.length >= 3);

      await pipeline.stop();
      await running;

      // The backlog is abandoned rather than delivered to a connection that is
      // closing, so most of the twenty frames never reach `handle`.
      expect(service.handled.length).toBeLessThan(21);
      expect(connection.closed).toBe(true);
    });
  });

  describe("failure", () => {
    test("reports a failed handshake as an error frame, and the session lives", async () => {
      const service = new TestService(() => Promise.reject(new Error("no connection")));
      const seen: Frame[] = [];

      class Sink extends FrameProcessor {
        protected override async process(frame: Frame): Promise<void> {
          seen.push(frame);
        }
      }

      const sink = new Sink("sink");
      const pipeline = new Pipeline([service, sink]);
      const running = pipeline.start(RATES);

      pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
      await until(() => seen.some((frame) => frame.kind === "error"));
      const error = seen.find((frame) => frame.kind === "error");
      expect(error).toMatchObject({ kind: "error", source: "service", message: "no connection" });

      // The loop is still alive: an end frame is honoured and the run resolves,
      // which a stopped pipeline could not do. The audio frame itself is held
      // forever — the connection never opened, so there is nothing to deliver
      // it to — but waiting on it would be waiting on nothing.
      await pipeline.stop();
      await running;
    });

    test("reports a failure from handle as an error frame, and keeps delivering", async () => {
      const service = new TestService();
      let calls = 0;
      service.overrideHandle = async (
        frame: Frame,
        connection: ServiceConnection,
      ): Promise<void> => {
        calls++;
        if (calls === 1) {
          // Recorded before throwing, so the test can see the frame arrived.
          service.handled.push(frame);
          throw new Error("provider rejected the request");
        }
        connection.send(frame.kind);
      };

      const seen: Frame[] = [];
      class Sink extends FrameProcessor {
        protected override async process(frame: Frame): Promise<void> {
          seen.push(frame);
        }
      }

      const sink = new Sink("sink");
      const pipeline = new Pipeline([service, sink]);
      const running = pipeline.start(RATES);

      // The first frame fails; the second is delivered to the connection.
      pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
      pipeline.push(createFrame({ kind: "userStoppedSpeaking" }));
      await until(() => seen.some((frame) => frame.kind === "error"));
      expect(seen.find((frame) => frame.kind === "error")).toMatchObject({
        source: "service",
        message: "provider rejected the request",
      });
      await until(() => service.fake.sent.includes("userStoppedSpeaking"));

      // A second failure is the same degraded session, so it is not reported
      // again: a dozen error frames about one dead service would bury the
      // first, which is the one an operator needs to see.
      service.overrideHandle = async (): Promise<void> => {
        throw new Error("a second failure");
      };
      pipeline.push(createFrame({ kind: "userStartedSpeaking" }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(seen.filter((frame) => frame.kind === "error")).toHaveLength(1);

      await pipeline.stop();
      await running;
    });

    test("does not report a failure caused by shutdown", async () => {
      const gated = gatedConnection(new FakeConnection());
      const service = new TestService(gated.connect);
      const seen: Frame[] = [];
      class Sink extends FrameProcessor {
        protected override async process(frame: Frame): Promise<void> {
          seen.push(frame);
        }
      }

      const sink = new Sink("sink");
      const pipeline = new Pipeline([service, sink]);
      const running = pipeline.start(RATES);
      await until(() => gated.started());

      // Shutdown aborts the handshake, which rejects it. That is not a fault:
      // the session ended on purpose, and reporting it would look like a
      // broken service for a session that ended normally.
      await pipeline.stop();
      await running;

      expect(seen.some((frame) => frame.kind === "error")).toBe(false);
    });
  });
});
