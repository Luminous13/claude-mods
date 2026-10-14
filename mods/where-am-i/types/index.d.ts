export type Recap = { goal: string; now: string; waiting: string; next: string }

declare module 'claude-code' {
  interface PluginState {
    // hosts: true once this mod draws the one card, the next-steps list inside it.
    'where-am-i': { recap: Recap | null; live: string; frame: number; dismissed: string; hosts: boolean }
    // Owned by the next-steps mod, read here. Kept the same as its own contract.
    'next-steps': { steps: { turnId: string; items: string[] } | null; active: boolean; armed: boolean; leader: string }
  }
}
