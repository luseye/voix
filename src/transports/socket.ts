/**
 * The part of a client connection a transport needs.
 *
 * A transport is given one of these per connection rather than creating it, so
 * the connection's lifetime is owned by the server and a transport can be
 * tested without opening a socket. Bun's `ServerWebSocket` satisfies this
 * interface structurally.
 */
export interface ClientSocket {
  /**
   * Send a message to the client.
   *
   * Binary payloads are audio; strings are JSON control messages.
   *
   * @param data The message to send.
   */
  send(data: Uint8Array | string): void;

  /**
   * Close the connection.
   *
   * @param code A close code.
   * @param reason A close reason.
   */
  close(code?: number, reason?: string): void;
}
