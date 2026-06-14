import type { Message, MessageInput } from "./types"

export type MessageHandler = (message: Message) => void
export type MessageFilter = (message: Message) => boolean

let counter = 0
function nextId() {
  counter += 1
  return `msg_${Date.now().toString(36)}_${counter.toString(36)}`
}

/**
 * In-memory pub/sub bus for inter-agent messages. It records history so the UI
 * can replay the conversation between agents (the "Comunicación" panel) and
 * notifies subscribers as messages flow.
 */
export class MessageRouter {
  private handlers = new Set<MessageHandler>()
  private log: Message[] = []
  private limit: number

  constructor(opts?: { historyLimit?: number }) {
    this.limit = opts?.historyLimit ?? 1000
  }

  /** Stamp, record and broadcast a message. Returns the stored message. */
  send(input: MessageInput): Message {
    const message: Message = { ...input, id: nextId(), timestamp: Date.now() }
    this.log.push(message)
    if (this.log.length > this.limit) this.log.splice(0, this.log.length - this.limit)
    for (const handler of [...this.handlers]) handler(message)
    return message
  }

  /** Subscribe to messages, optionally filtered. Returns an unsubscribe fn. */
  subscribe(handler: MessageHandler, filter?: MessageFilter): () => void {
    const wrapped: MessageHandler = filter
      ? (m) => {
          if (filter(m)) handler(m)
        }
      : handler
    this.handlers.add(wrapped)
    return () => {
      this.handlers.delete(wrapped)
    }
  }

  /** Snapshot of recorded messages, optionally filtered. */
  history(filter?: MessageFilter): Message[] {
    return filter ? this.log.filter(filter) : [...this.log]
  }

  /** Messages involving a given participant (as sender or recipient). */
  conversation(participant: string): Message[] {
    return this.log.filter((m) => m.from === participant || m.to === participant)
  }

  clear() {
    this.log = []
  }
}
