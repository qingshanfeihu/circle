// What the screen keeps about the turn in progress and the turns before it, from the event
// bus: the busy word and the tokens written so far, how long each answer thought, and the
// line under each finished turn (`12s · ↑ 1.2k · ↓ 340`). Time spent waiting on you (an
// approval, a question) does not count. Kept in memory only, as the Python version did: a
// reopened session has no turn lines.
import type { CircleEvent } from '../events.js';
import type { Message } from '../types.js';
import { pickBusyVerb, type TurnUsage } from './status_rows.js';
import type { ScreenState } from './render.js';

export class TurnStatus {
  verb = 'Brewing';
  tokens = 0;
  readonly usage: Record<string, TurnUsage> = {};
  readonly thinking: Record<string, number> = {};
  private live?: number;
  private thinkingFrom?: number;
  private turn?: {
    started: number;
    waited: number;
    waitingSince?: number;
    input: number;
    output: number;
  };
  constructor(private random = Math.random) {}

  // `lastMessage` names the message the turn's line goes under when the turn ends.
  apply(
    event: CircleEvent,
    lastMessage: () => string | undefined,
    now = Date.now(),
  ): void {
    const subagent = Boolean(event.tags.subagent);
    // A background agent's work is not this turn's.
    if (subagent && event.tags.job_id) return;
    const turn = this.turn;
    if (event.kind === 'tool_waiting' && turn) turn.waitingSince ??= now;
    if (
      (event.kind === 'tool_start' || event.kind === 'tool_result') &&
      turn?.waitingSince !== undefined
    ) {
      turn.waited += now - turn.waitingSince;
      turn.waitingSince = undefined;
    }
    if (event.kind === 'llm_end') {
      const output = event.usage?.output_tokens ?? 0;
      this.tokens += output;
      if (turn) {
        turn.input += event.usage?.input_tokens ?? 0;
        turn.output += output;
      }
    }
    if (subagent) return;
    if (event.kind === 'run_start') {
      this.verb = pickBusyVerb(this.random);
      this.tokens = 0;
      this.turn = { started: now, waited: 0, input: 0, output: 0 };
      this.thinkingFrom = this.live = undefined;
    } else if (event.kind === 'llm_start')
      this.thinkingFrom = this.live = undefined;
    else if (event.kind === 'llm_token') {
      if (event.payload.thinking) this.thinkingFrom ??= now;
      else if (this.thinkingFrom !== undefined && this.live === undefined)
        this.live = (now - this.thinkingFrom) / 1000;
    } else if (event.kind === 'llm_end') {
      const message = event.payload.message as Message | undefined;
      if (message?.id && this.thinkingFrom !== undefined)
        this.thinking[message.id] =
          this.live ?? (now - this.thinkingFrom) / 1000;
      this.thinkingFrom = this.live = undefined;
    } else if (
      (event.kind === 'run_end' || event.kind === 'run_error') &&
      turn
    ) {
      if (turn.waitingSince !== undefined)
        turn.waited += now - turn.waitingSince;
      const id = lastMessage();
      if (id)
        this.usage[id] = {
          seconds: Math.max(0, (now - turn.started - turn.waited) / 1000),
          input: turn.input,
          output: turn.output,
        };
      this.turn = undefined;
    }
  }

  // The thinking streaming now: how long it took, once the answer's text has begun.
  get liveSeconds(): number | undefined {
    return this.live;
  }

  fill(state: ScreenState): void {
    state.busyVerb = this.verb;
    state.busyTokens = this.tokens;
    state.turnUsage = this.usage;
    state.thinkingSeconds = this.thinking;
    state.liveThinkingSeconds = this.live;
  }
}
