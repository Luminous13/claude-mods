export type Recap = { goal: string; now: string; waiting: string; next: string }
export type NextSteps = { turnId: string; items: string[] }

declare module 'claude-code' {
  interface PluginState {
    // steps: the suggested next prompts for a turn; armed: the prompt holds the leader alone.
    'where-am-i': { recap: Recap | null; live: string; frame: number; steps: NextSteps | null; armed: boolean }
  }
}
