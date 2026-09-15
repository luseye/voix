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
  /**
   * An HTML entry point to serve at the root, for a browser client.
   *
   * Passed as Bun's own HTML import — `import page from "./client.html"` — so
   * that the page's TypeScript modules are bundled and served alongside it.
   * Without this, a browser client would have to be built by hand and hosted
   * separately, which is a lot of setup for something meant to be opened.
   */
  readonly page?: Bun.HTMLBundle;
}

/**
 * Start a server that runs a session per connection.
 *
 * @param server The session server to drive.
 * @param options Where to listen, and what to serve at the root.
 * @returns The Bun server handle, which can be stopped by the caller.
 */
export function serve(server: WebSocketServer, options: ServeOptions): Bun.Server<undefined> {
  const path = options.path ?? "/";
  const page = options.page;

  const upgrade = (request: Request, bunServer: Bun.Server<undefined>): Response | undefined => {
    if (bunServer.upgrade(request)) {
      return undefined;
    }
    return new Response("expected a WebSocket upgrade", { status: 426 });
  };

  // The root is only registered when there is a page, so an unset page leaves
  // it a 404 rather than serving something empty. Bun's route types reject a
  // conditional spread here, so the two shapes are written out.
  const routes =
    page === undefined ? { [path]: upgrade } : { "/": page, [path]: upgrade };

  return Bun.serve({
    port: options.port,
    routes,
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
