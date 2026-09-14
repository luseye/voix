/**
 * Wire a `WebSocketServer` to a real Bun server.
 *
 * The server class owns sessions but knows nothing about Bun's socket API;
 * this is the small amount of glue that turns its callbacks into the
 * `websocket` handlers `Bun.serve` expects. Keeping it separate means the
 * session logic can be tested without opening a port.
 */

import { WebSocketServer } from "./websocket-server.ts";

/** Options for `serve`. */
export interface ServeOptions {
  /** The port to listen on. Zero picks a free one. */
  readonly port: number;
  /** The path clients connect to. Defaults to `/`. */
  readonly path?: string;
}

/**
 * Start a server that runs a session per connection.
 *
 * @param server The session server to drive.
 * @param options Where to listen.
 * @returns The Bun server handle, which can be stopped by the caller.
 */
export function serve(server: WebSocketServer, options: ServeOptions): Bun.Server<undefined> {
  const path = options.path ?? "/";

  return Bun.serve({
    port: options.port,
    fetch(request, bunServer) {
      if (new URL(request.url).pathname !== path) {
        return new Response("not found", { status: 404 });
      }
      if (bunServer.upgrade(request)) {
        return undefined;
      }
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      open(socket) {
        server.handleOpen(socket);
      },
      message(socket, message) {
        server.handleMessage(socket, message);
      },
      close(socket) {
        server.handleClose(socket);
      },
    },
  });
}
