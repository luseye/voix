/**
 * Where a browser client opens its session.
 *
 * Kept out of the page so it can be tested: the protocol is the one part of
 * the connection that a browser will not let you get wrong quietly. A page
 * served over HTTPS that opens a `ws:` socket is blocked as mixed content, and
 * the failure looks like a server that is not there.
 */

/** The path the server runs a voice session at. */
export const VOICE_PATH = "/voice";

/**
 * The URL to open a session at, derived from where the page was served.
 *
 * The host is the page's own, so the client works wherever the server was
 * reached — a laptop, a LAN address, or a tunnel — without being told. Only
 * the protocol is changed, from the page's to the socket's.
 *
 * @param pageHref The page's own URL, which is `window.location.href`.
 * @returns The session URL.
 */
export function sessionUrl(pageHref: string): string {
  const url = new URL(VOICE_PATH, pageHref);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
