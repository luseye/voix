/**
 * The server's HTTP surface.
 *
 * `serve` is the only place the framework opens a port, so this is where the
 * routing rules are pinned: what a browser gets at the root, what a client
 * gets when it asks for a session without upgrading, and what happens when
 * there is no page to serve at all.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { Pipeline } from "../src/core/pipeline.ts";
import { serve } from "../src/transports/serve.ts";
import { WebSocketServer } from "../src/transports/websocket-server.ts";
import page from "../examples/voice-client.html";

const CONFIG = { sampleRateIn: 16000, sampleRateOut: 24000 };

/** A server that runs an empty session, enough to occupy the socket path. */
function server(): WebSocketServer {
  return new WebSocketServer(CONFIG, (transport) => new Pipeline([transport.input, transport.output]));
}

describe("serve", () => {
  const withPage = serve(server(), { port: 0, path: "/voice", page });
  const withoutPage = serve(server(), { port: 0, path: "/voice" });

  afterAll(() => {
    withPage.stop(true);
    withoutPage.stop(true);
  });

  test("serves the page at the root", async () => {
    const response = await fetch(`http://localhost:${withPage.port}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("serves the page's script so the browser has something to run", async () => {
    // The page is useless without its module, and the module is only reachable
    // because the HTML is imported rather than read as text: Bun rewrites the
    // script tag to a bundled URL it can serve.
    const html = await (await fetch(`http://localhost:${withPage.port}/`)).text();
    const src = /src="([^"]+)"/.exec(html)?.[1];
    expect(src).toBeDefined();

    const script = await fetch(`http://localhost:${withPage.port}${src!}`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("AudioWorklet");
  });

  test("has no root route when no page is given", async () => {
    // Without a page there is nothing to show, and a 404 says so rather than
    // serving an empty document a browser would render as a blank tab.
    const response = await fetch(`http://localhost:${withoutPage.port}/`);

    expect(response.status).toBe(404);
  });

  test("rejects a session request that is not an upgrade", async () => {
    // A plain GET to the session path is a mistake — a client that meant to
    // open a socket — and 426 tells it what it should have sent.
    const response = await fetch(`http://localhost:${withPage.port}/voice`);

    expect(response.status).toBe(426);
  });

  test("serves the session at the root when no path is given", async () => {
    // A server with no page has no reason to be told a path: the root is the
    // only thing it can serve, so it is the default.
    const rootOnly = serve(server(), { port: 0 });
    try {
      const socket = new WebSocket(`ws://localhost:${rootOnly.port}/`);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });

      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    } finally {
      rootOnly.stop(true);
    }
  });

  test("still upgrades a real session request when a page is served", async () => {
    // Serving a page must not cost the socket: the two routes coexist, and a
    // client that upgrades reaches a session.
    const socket = new WebSocket(`ws://localhost:${withPage.port}/voice`);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
