/**
 * Predictive local echo for remote terminals — the Mosh / VS Code idea, in
 * the safe subset that never corrupts the screen.
 *
 * The problem: every keystroke round-trips browser → API → sandbox pty →
 * bash echo → back before the glyph renders. Measured at ~175ms to E2B,
 * which is far past the ~30ms where typing feels broken. The fix everyone
 * converged on (Mosh's speculative echo, VS Code's TypeAhead addon behind
 * terminal.integrated.localEchoLatencyThreshold) is to render the expected
 * echo IMMEDIATELY and reconcile against the real stream: matching server
 * bytes are consumed silently (the glyph is already on screen), a mismatch
 * rolls the prediction back and goes passthrough for a cooldown.
 *
 * The subset that keeps rollback trivially correct — predictions happen only
 * when ALL of these hold:
 *   - normal buffer (alt-screen apps like vim draw their own echo)
 *   - a single printable ASCII char (paste, IME, control chars: passthrough)
 *   - the cursor sits at the END of the line's content (mid-line inserts
 *     shift cells; bash may redraw the tail — unpredictable)
 *   - not adjacent to the right edge (line-wrap echo is unpredictable)
 * Under those rules every pending prediction is exactly the last N cells
 * left of the cursor on the current row, so rollback is CUB(N) + EL — no
 * saved screen state, nothing to get out of sync.
 *
 * Any control key (Enter, backspace, ctrl-anything) first rolls back the
 * still-unconfirmed predictions and then passes through: the server's echo
 * redraws those characters authoritatively a round-trip later. This trades a
 * rare barely-visible re-echo for never having to predict readline's
 * responses to editing keys.
 *
 * Latency-gated like VS Code: confirmations keep an EMA of echo latency and
 * prediction turns itself off against a fast server (local dev), where it
 * could only add artifacts.
 */
import type { Terminal } from "@xterm/xterm";

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;
/** Below this echo latency prediction is pointless (VS Code defaults 30ms). */
const LATENCY_FLOOR_MS = 30;
/** An echo this old is lost; assume the stream diverged and reset. */
const CONFIRM_TIMEOUT_MS = 2000;
/** After a mismatch, stay passthrough this long. */
const COOLDOWN_MS = 3000;

interface Pending {
  ch: string;
  at: number;
}

export class TerminalTypeAhead {
  private pending: Pending[] = [];
  private cooldownUntil = 0;
  private latencyEma: number | null = null;

  constructor(private readonly term: Terminal) {}

  /**
   * Called with what the user typed, BEFORE it is sent. May optimistically
   * render. Never alters what gets sent.
   */
  onUserData(data: string): void {
    this.sweepStale();
    if (Date.now() < this.cooldownUntil) return;

    const printable =
      data.length === 1 &&
      data.charCodeAt(0) >= PRINTABLE_MIN &&
      data.charCodeAt(0) <= PRINTABLE_MAX;

    if (!printable) {
      // Editing/control input: withdraw unconfirmed predictions and let the
      // server be authoritative about what happens next.
      this.rollback();
      return;
    }

    if (this.latencyEma !== null && this.latencyEma < LATENCY_FLOOR_MS) return;

    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (!line) return;
    const content = line.translateToString(true);
    if (buffer.cursorX < content.length) return; // mid-line insert
    if (buffer.cursorX >= this.term.cols - 2) return; // wrap territory

    this.pending.push({ ch: data, at: Date.now() });
    this.term.write(data);
  }

  /**
   * Called with every server chunk. Returns what should actually be written
   * to the terminal — confirmed echoes removed, or a rollback prefix added.
   */
  onServerData(chunk: string): string {
    if (this.pending.length === 0) return chunk;
    this.sweepStale();
    if (this.pending.length === 0) return chunk;

    let i = 0;
    while (this.pending.length > 0 && i < chunk.length) {
      const head = this.pending[0];
      if (chunk[i] === head.ch) {
        i += 1;
        this.pending.shift();
        const sample = Date.now() - head.at;
        this.latencyEma =
          this.latencyEma === null
            ? sample
            : this.latencyEma * 0.8 + sample * 0.2;
      } else {
        // The stream disagrees with the prediction (job output, a prompt
        // redraw, readline doing something clever). Erase every predicted
        // glyph, then write the server's bytes verbatim — including the
        // echoes we are no longer suppressing.
        const rollback = this.rollbackSequence();
        this.pending = [];
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        return rollback + chunk.slice(i);
      }
    }
    return chunk.slice(i);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  dispose(): void {
    this.pending = [];
  }

  /** CUB(n) + EL: predictions are always the last n cells before the cursor. */
  private rollbackSequence(): string {
    const n = this.pending.length;
    return n > 0 ? `\x1b[${n}D\x1b[K` : "";
  }

  private rollback(): void {
    const seq = this.rollbackSequence();
    if (seq) this.term.write(seq);
    this.pending = [];
  }

  private sweepStale(): void {
    if (
      this.pending.length > 0 &&
      Date.now() - this.pending[0].at > CONFIRM_TIMEOUT_MS
    ) {
      this.rollback();
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
    }
  }
}
