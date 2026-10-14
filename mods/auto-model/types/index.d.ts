export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// What the line says auto-model did with a turn's model.
// `by` names the picker that answered; absent, Jev (what notes from before 0.4.0 meant).
export type Picker = 'jev' | 'openai' | 'claude'
export type Note =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'asking'; by?: Picker }
  | { kind: 'switched'; from: string; sure: number; by?: Picker } // ran below the model /model set
  | { kind: 'kept'; sure: number; by?: Picker } // the picker chose the model /model set
  | { kind: 'unsure'; sure: number; by?: Picker } // too unsure to switch
  | { kind: 'held'; sure: number; wanted: string; tokens: number; by?: Picker } // too much context to move down
  | { kind: 'none'; reason: string } // no pick: no key, no answer, no prompt…

// What auto-model did with a turn's effort: lowered it, held it for the cache, or left it.
export type EffortNote = 'auto' | 'held' | 'kept'

// The main loop as the line shows it: before any turn, during one, or after the last.
export type Main = { model: string; note: Note; phase: 'start' | 'running' | 'done'; effort?: string; effortNote?: EffortNote }

// The session's figures beside it: the context window's fill and the 7-day window.
export type Meter = { ctx?: number; sevenDay?: number }

// What the line under the prompt draws from.
export type Line = {
  main?: Main
  meter?: Meter
  subagents: Record<string, { model: string; at: number }> // by agent id, while running
}

// What the mod has done this session, for /auto-model.
export type Stats = {
  turns: Record<string, number> // by the label of the model the turn ran on
  switched: number
  lowered?: number // turns run below the effort /effort set
  jevUsd: number // what the picks cost, whichever picker answered (named before other pickers existed)
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// One subagent spawn and what auto-model did with its model.
export type Route = {
  id: string // the Agent tool call's id
  agentId?: string
  description: string
  type: string
  asked?: string // what it would run on without us; undefined when its own agent definition decides
  picked?: Tier // undefined when nothing picked: a named model, no key, or no answer
  by: Picker | 'none'
  confidence?: number // the picker's, 0 to 1 (Claude's is its own rating)
  reason: string
  applied: boolean // false in suggest mode, or when the pick matched what was asked
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  model?: string // what it ran on, as the API reports it
  usage?: Usage
  costUsd?: number // at API prices, for the tokens it used
  askedUsd?: number // the same tokens at the asked model's prices
  pickerUsd?: number // what the pick itself cost
}

declare module 'claude-code' {
  interface PluginState {
    // routes: the subagents this session and their picks, for /route; now: the band's clock.
    'auto-model': { stats: Stats; line: Line; routes: Route[]; now: number }
  }
}
