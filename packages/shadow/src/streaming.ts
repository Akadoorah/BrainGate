import type { ProviderId } from "@braingate/providers";

/**
 * How a provider's headless stream is shaped, for the providers whose shape has been measured.
 *
 * Not every CLI is here, and that is deliberate: a dialect is added when someone has watched
 * this build produce it, never because a format with the same name exists elsewhere.
 */
export type StreamDialect = "anthropic" | "xai";

export function streamDialectFor(providerId: ProviderId): StreamDialect | null {
  if (providerId === "anthropic") return "anthropic";
  if (providerId === "xai") return "xai";
  return null;
}

export interface StreamLineVerdict {
  /**
   * Whether the line belongs in the retained output.
   *
   * A token-level stream is mostly noise that the final parse never reads — Claude's thinking
   * and signature deltas are individually larger than the answer — and retaining it would spend
   * the output cap on text nobody looks at, killing long runs for the sake of a display.
   */
  readonly retain: boolean;
  /** Text the model produced, in order. Concatenated, these are its whole answer. */
  readonly answer: string | null;
  /** Reasoning, when the provider streams it separately. Shown as activity, never as the answer. */
  readonly thinking: boolean;
}

const NOTHING: StreamLineVerdict = Object.freeze({ retain: false, answer: null, thinking: false });
const KEEP: StreamLineVerdict = Object.freeze({ retain: true, answer: null, thinking: false });

function answerPiece(text: string): StreamLineVerdict {
  return Object.freeze({ retain: false, answer: text, thinking: false });
}

/**
 * Reads one line of a provider's stream.
 *
 * Measured 2026-09-09/10 against claude 2.1.266 and grok 1.0.24:
 *
 * - Claude emits `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":
 *   "text_delta","text":"…"}}}` per token, whole `assistant` messages as they complete, and one
 *   final result envelope carrying `result` and `usage`.
 * - Grok emits `{"type":"text","data":"…"}` per piece, `{"type":"thought","data":"…"}` while
 *   reasoning, and `{"type":"end",…,"usage":{…}}` last.
 */
export function readStreamLine(dialect: StreamDialect, line: string): StreamLineVerdict {
  const trimmed = line.trim();
  if (trimmed.length === 0) return NOTHING;
  // A line that is not JSON is an error message or a warning, and those are exactly the lines a
  // failure needs. Anything unrecognised is kept rather than dropped.
  if (!trimmed.startsWith("{")) return KEEP;
  let event: Record<string, unknown>;
  try { event = JSON.parse(trimmed) as Record<string, unknown>; }
  catch { return KEEP; }

  if (dialect === "anthropic") {
    if (event.type === "stream_event") {
      const inner = event.event;
      if (typeof inner !== "object" || inner === null) return NOTHING;
      const record = inner as Record<string, unknown>;
      if (record.type !== "content_block_delta") return NOTHING;
      const delta = record.delta;
      if (typeof delta !== "object" || delta === null) return NOTHING;
      const deltaRecord = delta as Record<string, unknown>;
      if (deltaRecord.type === "text_delta" && typeof deltaRecord.text === "string") return answerPiece(deltaRecord.text);
      if (deltaRecord.type === "thinking_delta") return Object.freeze({ retain: false, answer: null, thinking: true });
      return NOTHING;
    }
    // Whole messages repeat what the deltas already carried, and the signatures attached to them
    // are large. The final envelope is what the parse and the usage accounting read.
    if (event.type === "assistant" || event.type === "user") return NOTHING;
    return KEEP;
  }

  if (event.type === "text" && typeof event.data === "string") return answerPiece(event.data);
  if (event.type === "thought") return Object.freeze({ retain: false, answer: null, thinking: true });
  // Grok repeats its whole tool list on every connection; it says nothing about this run.
  if (event.type === "available_commands") return NOTHING;
  return KEEP;
}

/**
 * The prose inside a contract answer, as it arrives.
 *
 * A provider under an enforced schema does not stream prose: it streams the JSON of the
 * contract, one fragment at a time. Showing that to someone waiting is worse than showing
 * nothing — so this walks the JSON as it is built and emits only the decoded characters of the
 * field that holds the human-readable part.
 *
 * It never guesses. Until the field's opening quote has actually arrived, it emits nothing.
 */
export class ContractTextStream {
  /** The contract fields that hold prose, in the order a response might use them. */
  static readonly FIELDS: readonly string[] = Object.freeze(["output", "rationale", "summary"]);

  #buffer = "";
  #start: number | null = null;
  #cursor = 0;
  #done = false;

  /** Feeds the next fragment of the answer and returns whatever prose became readable. */
  push(fragment: string): string {
    if (this.#done || fragment.length === 0) return "";
    this.#buffer += fragment;
    if (this.#start === null) {
      for (const field of ContractTextStream.FIELDS) {
        const marker = `"${field}"`;
        const at = this.#buffer.indexOf(marker);
        if (at < 0) continue;
        const quote = this.#buffer.indexOf('"', this.#buffer.indexOf(":", at + marker.length) + 1);
        if (quote < 0) continue;
        this.#start = quote + 1;
        this.#cursor = this.#start;
        break;
      }
      if (this.#start === null) return "";
    }
    return this.#drain();
  }

  #drain(): string {
    let out = "";
    while (this.#cursor < this.#buffer.length) {
      const character = this.#buffer[this.#cursor]!;
      if (character === "\\") {
        // An escape needs its second character before it can be decoded, and a unicode escape
        // needs four more. Stopping here leaves the cursor on the backslash, so the next
        // fragment completes it rather than losing it.
        const next = this.#buffer[this.#cursor + 1];
        if (next === undefined) break;
        if (next === "u") {
          if (this.#cursor + 6 > this.#buffer.length) break;
          out += String.fromCharCode(Number.parseInt(this.#buffer.slice(this.#cursor + 2, this.#cursor + 6), 16));
          this.#cursor += 6;
          continue;
        }
        out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
        this.#cursor += 2;
        continue;
      }
      if (character === '"') { this.#done = true; break; }
      out += character;
      this.#cursor += 1;
    }
    return out;
  }
}

/**
 * Splits a stream into whole lines, keeping whatever is incomplete for the next chunk.
 *
 * A chunk boundary lands mid-line often enough that parsing chunks directly loses events, and
 * loses them silently: the JSON simply fails to parse and the piece is dropped.
 */
export class LineBuffer {
  #partial = "";

  take(chunk: string): readonly string[] {
    const combined = this.#partial + chunk;
    const pieces = combined.split(/\r?\n/);
    this.#partial = pieces.pop() ?? "";
    return Object.freeze(pieces);
  }

  /** Whatever never ended in a newline. Called once, when the process closes. */
  flush(): string {
    const rest = this.#partial;
    this.#partial = "";
    return rest;
  }
}
