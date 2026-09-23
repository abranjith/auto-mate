import type { AgentEvent } from '@automate/core';

/** Coalesce assistant deltas before sequence allocation and durable append. */
export class TextCoalescer {
  private text = '';
  private at = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly emit: (
      event: Extract<AgentEvent, { type: 'assistant_text' }>,
    ) => void,
    private readonly delayMs = 100,
    private readonly maxBytes = 1024,
  ) {}
  push(event: Extract<AgentEvent, { type: 'assistant_text' }>): void {
    if (!this.text) {
      this.at = event.at;
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
    this.text += event.text;
    if (new TextEncoder().encode(this.text).byteLength >= this.maxBytes)
      this.flush();
  }
  flush(): void {
    if (!this.text) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const event = {
      type: 'assistant_text' as const,
      text: this.text,
      at: this.at,
    };
    this.text = '';
    this.at = '';
    this.timer = undefined;
    this.emit(event);
  }
  dispose(): void {
    this.flush();
  }
}
