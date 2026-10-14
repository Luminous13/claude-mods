export type NextSteps = { turnId: string; items: string[] }

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { steps: NextSteps | null; active: boolean; armed: boolean; leader: string }
    // Owned by the where-am-i mod, read here. Kept the same as its own contract.
    'where-am-i': { recap: { goal: string; now: string; waiting: string; next: string } | null; live: string; hosts: boolean }
  }
}
