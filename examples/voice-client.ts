/**
 * The browser client for the voice agent.
 *
 * It does three things: captures the microphone, streams it to the server as
 * the bytes the pipeline expects, and plays the reply as it arrives. The
 * conversion lives in `browser-audio.ts`; this is the wiring around it — the
 * audio graph, the socket, and the button.
 *
 * The whole thing is started by a click rather than on load. Browsers refuse
 * to open a microphone or an audio device without a user gesture, so there is
 * no honest way to begin before the user asks.
 */

import { MicrophoneEncoder, PlaybackDecoder, SEND_RATE } from "./browser-audio.ts";
import { sessionUrl } from "./session-url.ts";

/**
 * How much audio to gather before sending.
 *
 * A worklet delivers 128 samples at a time, which is a few milliseconds. Sending
 * each one would be a message every couple of milliseconds for very little
 * audio, so the chunks are gathered into something closer to a network packet.
 * 20ms at the send rate is small enough to stay responsive and large enough that
 * the per-message overhead does not dominate.
 */
const SEND_CHUNK_BYTES = (SEND_RATE * 2 * 20) / 1000;

/**
 * The capture worklet, as source text.
 *
 * `addModule` takes a URL, and the bundler leaves the string inside `new URL`
 * alone — a separate `.ts` file would be fetched as a module the browser cannot
 * run. A blob URL sidesteps that: the worklet imports nothing, so its source is
 * the whole module.
 */
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // The buffer is reused by the audio thread, so it is copied before it
      // crosses to the main thread.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
`;

/** Look up an element the page is expected to have. */
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The page is missing an element with id "${id}"`);
  }
  return found as T;
}

/** Open the session socket, resolving once it is ready to carry audio. */
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(sessionUrl(window.location.href));
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("connection failed")), {
      once: true,
    });
  });
}

/** A running conversation: a microphone, a socket, and a speaker. */
class Session {
  readonly #context: AudioContext;
  readonly #socket: WebSocket;
  readonly #encoder: MicrophoneEncoder;
  readonly #playback: PlaybackDecoder;
  readonly #capture: AudioWorkletNode;
  readonly #stream: MediaStream;

  // Audio waiting to be sent, gathered until it reaches `SEND_CHUNK_BYTES`.
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;

  // When the next reply chunk should play, so that chunks queue in order
  // instead of all starting at once.
  #playhead = 0;

  private constructor(
    context: AudioContext,
    socket: WebSocket,
    capture: AudioWorkletNode,
    stream: MediaStream,
  ) {
    this.#context = context;
    this.#socket = socket;
    this.#capture = capture;
    this.#stream = stream;
    this.#encoder = new MicrophoneEncoder(context.sampleRate);
    this.#playback = new PlaybackDecoder(context.sampleRate);

    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => this.#onMessage(event));

    capture.port.addEventListener("message", (event) => {
      this.#onAudio((event as MessageEvent).data as Float32Array);
    });
    capture.port.start();
  }

  /**
   * Open the microphone and the connection.
   *
   * @returns A session that is already listening.
   */
  static async start(): Promise<Session> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    // The device's own rate, which is what the encoder resamples from.
    const context = new AudioContext();

    const module = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(module);
    } finally {
      URL.revokeObjectURL(module);
    }

    const capture = new AudioWorkletNode(context, "capture");

    // A worklet only runs while it is being pulled, and a node is pulled when
    // something reaches the output. The worklet writes no output of its own, so
    // this plays silence while keeping the capture alive.
    capture.connect(context.destination);

    const source = context.createMediaStreamSource(stream);
    source.connect(capture);

    let socket: WebSocket;
    try {
      socket = await connect();
    } catch (error) {
      // The microphone and the audio device are already open. Leaving them
      // would keep the recording indicator on and hold the device against the
      // next attempt.
      capture.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      throw error;
    }

    return new Session(context, socket, capture, stream);
  }

  /** Stop listening, close the connection, and release the devices. */
  async stop(): Promise<void> {
    this.#flush();

    this.#capture.disconnect();
    this.#stream.getTracks().forEach((track) => track.stop());
    this.#socket.close();

    // Closing the context releases the output device; without it a browser
    // keeps the tab marked as playing audio.
    await this.#context.close();
  }

  /** Gather one chunk of microphone audio, sending when there is enough. */
  #onAudio(samples: Float32Array): void {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const bytes = this.#encoder.encode(samples);
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.length;

    if (this.#pendingBytes >= SEND_CHUNK_BYTES) {
      this.#flush();
    }
  }

  /** Send whatever audio is waiting, as one message. */
  #flush(): void {
    if (this.#pendingBytes === 0 || this.#socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = new Uint8Array(this.#pendingBytes);
    let offset = 0;
    for (const piece of this.#pending) {
      message.set(piece, offset);
      offset += piece.length;
    }

    this.#pending = [];
    this.#pendingBytes = 0;
    this.#socket.send(message);
  }

  /** Play one chunk of the reply. */
  #onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      // Control messages from the server are not part of the protocol yet.
      return;
    }

    const samples = this.#playback.decode(new Uint8Array(event.data as ArrayBuffer));
    if (samples.length === 0) {
      return;
    }

    const buffer = this.#context.createBuffer(1, samples.length, this.#context.sampleRate);
    buffer.getChannelData(0).set(samples);

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);

    // Chunks are scheduled back to back. If the queue has fallen behind the
    // clock — the network stalled — playback restarts from now rather than
    // trying to catch up, which would sound like a fast-forward.
    const startAt = Math.max(this.#context.currentTime, this.#playhead);
    source.start(startAt);
    this.#playhead = startAt + buffer.duration;
  }
}

const button = element<HTMLButtonElement>("talk");
const status = element<HTMLParagraphElement>("status");

let session: Session | undefined;

button.addEventListener("click", async () => {
  if (session !== undefined) {
    await session.stop();
    session = undefined;
    button.textContent = "Start talking";
    status.textContent = "Stopped.";
    return;
  }

  button.disabled = true;
  status.textContent = "Connecting…";
  try {
    session = await Session.start();
    button.textContent = "Stop";
    status.textContent = "Listening — say something.";
  } catch (error) {
    status.textContent = `Could not start: ${String(error)}`;
  } finally {
    button.disabled = false;
  }
});
