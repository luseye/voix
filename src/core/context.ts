/**
 * The conversation history a language model is given.
 *
 * A model has no memory of its own: each request carries the whole
 * conversation, and the reply is appended so the next request includes it. That
 * history is what this holds.
 *
 * Messages are kept in the order they were added, because the order is the
 * conversation and a model reads it as one. The system prompt is simply the
 * first message added, which is why there is no separate field for it: a
 * provider that takes it in a distinct parameter can read it off the front.
 */

/** Who said a message. */
export type Role = "system" | "user" | "assistant";

/** One turn of the conversation. */
export interface Message {
  readonly role: Role;
  readonly content: string;
}

export class LLMContext {
  readonly #messages: Message[] = [];

  /**
   * @param systemPrompt An optional opening instruction, added before anything
   *   else so it leads the history.
   */
  constructor(systemPrompt?: string) {
    if (systemPrompt !== undefined) {
      this.addMessage({ role: "system", content: systemPrompt });
    }
  }

  /** How many messages the history holds. */
  get length(): number {
    return this.#messages.length;
  }

  /**
   * Append a message to the history.
   *
   * @param message The message to add.
   */
  addMessage(message: Message): void {
    this.#messages.push(message);
  }

  /**
   * The history, oldest first.
   *
   * A copy of the array, so adding to the context later cannot change a list a
   * caller already holds. The messages are not copied: their fields are
   * `readonly`, so a caller has no supported way to change one.
   *
   * @returns The messages.
   */
  getMessages(): readonly Message[] {
    return [...this.#messages];
  }

  /**
   * Remove every message, leaving the context empty.
   *
   * Used when a conversation is reset. It is not the same as ending a session:
   * the context outlives a single turn, and clearing it mid-session is a
   * deliberate act, not something shutdown does.
   */
  clear(): void {
    this.#messages.length = 0;
  }
}
