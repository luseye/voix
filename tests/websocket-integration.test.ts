/**
 * End-to-end over a real socket.
 *
 * The other transport tests use a fake socket, which proves the logic but not
 * that Bun's own `ServerWebSocket` satisfies `ClientSocket`. This test opens a
 * real server, connects a real client, and sends real bytes, so the interface
 * is checked by the compiler and the wiring by the runtime.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";
import { serve } from "../src/transports/serve.ts";
import { WebSocketServer } from "../src/transports/websocket-server.ts";

const CONFIG = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** Records every frame it sees and forwards it. */
class Spy extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
    this.push(frame);
  }
}

/** Little-endian bytes for a run of samples, as a client would send them. */
function bytes(samples: number[]): Uint8Array {
  const buffer = new Uint8Array(samples.length * 2);
  const view = new DataView(buffer.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return buffer;
}

/** Resolves with the next message the client receives. */
function nextMessage(socket: WebSocket): Promise<Uint8Array | string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message arrived")), 2000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        const data = (event as MessageEvent).data;
        resolve(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
      },
      { once: true },
    );
  });
}

/** Resolves once a condition holds. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

describe("WebSocket end to end", () => {
  const spies: Spy[] = [];
  const pipelines: Pipeline[] = [];

  const server = new WebSocketServer(CONFIG, (transport) => {
    const spy = new Spy("spy");
    spies.push(spy);
    const pipeline = new Pipeline([transport.input, spy, transport.output]);
    pipelines.push(pipeline);
    return pipeline;
  });

  const listening = serve(server, { port: 0, path: "/voice" });

  afterAll(async () => {
    await server.stopAll();
    listening.stop(true);
  });

  test("carries audio in both directions", async () => {
    const client = new WebSocket(`ws://localhost:${listening.port}/voice`);
    await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
    await until(() => spies.length === 1);

    // In: the client's bytes become an inputAudio frame.
    client.send(bytes([100, 200]));
    await until(() => spies[0]!.seen.some((frame) => frame.kind === "inputAudio"));
    const audio = spies[0]!.seen.find((frame) => frame.kind === "inputAudio");
    expect((audio as { data: Int16Array }).data).toEqual(Int16Array.from([100, 200]));

    // Out: a ttsAudio frame reaches the client as bytes.
    const received = nextMessage(client);
    pipelines[0]!.push(createFrame({ kind: "ttsAudio", data: Int16Array.from([7, 8]) }));

    const message = await received;
    expect(typeof message).not.toBe("string");
    expect(new Int16Array((message as Uint8Array).buffer)).toEqual(Int16Array.from([7, 8]));

    client.close();
  });

  test("carries a control message", async () => {
    const client = new WebSocket(`ws://localhost:${listening.port}/voice`);
    await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
    await until(() => spies.length === 2);

    client.send('{"type":"llmRun"}');
    await until(() => spies[1]!.seen.some((frame) => frame.kind === "llmRun"));

    client.close();
  });

  test("ends the session when the client disconnects", async () => {
    const client = new WebSocket(`ws://localhost:${listening.port}/voice`);
    await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
    await until(() => spies.length === 3);

    client.close();
    await until(() => !pipelines[2]!.isRunning);
  });

  test("rejects an upgrade on another path", async () => {
    const response = await fetch(`http://localhost:${listening.port}/elsewhere`);

    expect(response.status).toBe(404);
  });

  test("echoes audio back through the transport", async () => {
    // This is the example's shape, pinned here so the demo cannot rot: audio
    // in becomes inputAudio, is turned into ttsAudio, and comes back out.
    const client = new WebSocket(`ws://localhost:${listening.port}/voice`);
    await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
    await until(() => spies.length === 4);

    const received = nextMessage(client);
    // 258 in little-endian order, sent as raw bytes rather than as samples.
    client.send(new Uint8Array([0x02, 0x01]));

    // The pipeline forwards the inputAudio frame to the spy, and the test
    // turns it around the way the echo example does.
    await until(() => spies[3]!.seen.some((frame) => frame.kind === "inputAudio"));
    const audio = spies[3]!.seen.find((frame) => frame.kind === "inputAudio");
    pipelines[3]!.push(
      createFrame({ kind: "ttsAudio", data: (audio as { data: Int16Array }).data }),
    );

    const message = await received;
    expect(new Int16Array((message as Uint8Array).buffer)).toEqual(Int16Array.from([258]));

    client.close();
  });
});
