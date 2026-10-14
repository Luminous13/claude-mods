// Who picks, and how each picker is asked: the same multiple-choice questions over the same
// state, sent in each API's own shape and read back into one form. Kept free of the engine so
// tests call it directly.
//   Jev (TypeSafe) and OpenAI's Decisions API are decision models: they answer a choice with
//   probabilities and a confidence. Claude has no such endpoint, so it is asked through the
//   session's own client for JSON naming its choices and how sure it is, a self-rating rather
//   than a calibrated probability.
import type { Usage } from '../types'

export type PickerName = 'jev' | 'openai' | 'claude'
export const PICKER_LABEL: Record<PickerName, string> = { jev: 'Jev', openai: 'OpenAI', claude: 'Claude' }

export function pickerOf(setting: unknown): PickerName {
  return setting === 'openai' || setting === 'claude' ? setting : 'jev'
}

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const OPENAI_URL = 'https://api.openai.com/v1/decisions'
const OPENAI_MODEL = 'gpt-6-luna'
export const CLAUDE_PICK_MODEL = 'haiku' // an alias the session resolves, so it follows the current Haiku
const USD_PER_INPUT_TOKEN: Record<'jev' | 'openai', number> = { jev: 0.042 / 1_000_000, openai: 0.1 / 1_000_000 } // neither bills output
const CLAUDE_HAIKU = { input: 0.1 / 1_000_000, output: 0.5 / 1_000_000, cacheRead: 0.01 / 1_000_000 } // Haiku 5.5, as of 2026-10-06

// One multiple-choice question: its name, what to weigh, and what each choice is for.
export type Question = { name: string; instructions: string; criteria: Record<string, string> }

// A picker's answers, by question name, each a valid choice; and what asking cost.
export type Answer = { choice: string; confidence: number }
export type Answered = { answers: Record<string, Answer>; costUsd: number }

// ---------------------------------------------------------------- Jev

export function jevBody(state: object, questions: readonly Question[]) {
  return {
    model: 'jev-latest',
    state,
    questions: Object.fromEntries(questions.map(q => [q.name, { type: 'choice', instructions: q.instructions, criteria: q.criteria }])),
  }
}

// Jev keys its answers by question name, with a confidence or, failing that, probabilities.
export function parseJevAnswers(text: string, questions: readonly Question[]): Answered | null {
  const body = json(text)
  if (!body) return null
  const answers: Record<string, Answer> = {}
  for (const q of questions) {
    const a = body.answers?.[q.name]
    if (!a || !isChoice(q, a.choice)) continue
    const sure = typeof a.confidence === 'number' ? a.confidence : typeof a.probabilities?.[a.choice] === 'number' ? a.probabilities[a.choice] : 0
    answers[q.name] = { choice: a.choice, confidence: sure }
  }
  const tokens = body.usage?.input_tokens ?? body.usage?.inputTokens
  return { answers, costUsd: typeof tokens === 'number' ? tokens * USD_PER_INPUT_TOKEN.jev : 0 }
}

// ---------------------------------------------------------------- OpenAI

export function openaiBody(state: object, questions: readonly Question[]) {
  return {
    model: OPENAI_MODEL,
    input: JSON.stringify(state),
    questions: questions.map(q => ({
      type: 'choice',
      name: q.name,
      instructions: q.instructions,
      choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })),
    })),
  }
}

// OpenAI lists its answers, each named, with probabilities as a list.
export function parseOpenaiAnswers(text: string, questions: readonly Question[]): Answered | null {
  const body = json(text)
  if (!body || !Array.isArray(body.answers)) return null
  const answers: Record<string, Answer> = {}
  for (const q of questions) {
    const a = body.answers.find((x: any) => x?.name === q.name)
    if (!a || !isChoice(q, a.choice)) continue
    const probability = Array.isArray(a.probabilities) ? a.probabilities.find((p: any) => p?.value === a.choice)?.probability : undefined
    answers[q.name] = { choice: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : typeof probability === 'number' ? probability : 0 }
  }
  const tokens = body.usage?.input_tokens
  return { answers, costUsd: typeof tokens === 'number' ? tokens * USD_PER_INPUT_TOKEN.openai : 0 }
}

// ---------------------------------------------------------------- Claude

// The system prompt and message for one pick: the state, then each question and its choices.
export function claudeAsk(state: object, questions: readonly Question[]): { system: string; prompt: string } {
  const shape = `{${questions.map(q => `"${q.name}": "<one of ${Object.keys(q.criteria).join(', ')}>"`).join(', ')}, "confidence": <0 to 1>}`
  return {
    system:
      'You choose settings for a coding agent. Answer each question with exactly one of its choices, ' +
      'and say how sure you are of the answers as a number from 0 to 1. Reply with JSON only, no prose: ' +
      shape,
    prompt: [
      `<state>\n${JSON.stringify(state)}\n</state>`,
      ...questions.map(q => `Question "${q.name}": ${q.instructions}\nChoices:\n${Object.entries(q.criteria).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`),
    ].join('\n\n'),
  }
}

// Claude's JSON reply. Its confidence is its own rating, shared by every answer; missing, 0.5.
export function parseClaudeAnswers(text: string, questions: readonly Question[], usage?: Usage): Answered | null {
  const match = /\{[\s\S]*\}/.exec(text)
  const body = match ? json(match[0]) : null
  if (!body) return null
  const rated = typeof body.confidence === 'number' ? Math.min(1, Math.max(0, body.confidence)) : 0.5
  const answers: Record<string, Answer> = {}
  for (const q of questions) {
    const choice = body[q.name]
    if (isChoice(q, choice)) answers[q.name] = { choice, confidence: rated }
  }
  const costUsd = usage
    ? (usage.input_tokens + usage.cache_creation_input_tokens * 1.25) * CLAUDE_HAIKU.input + usage.cache_read_input_tokens * CLAUDE_HAIKU.cacheRead + usage.output_tokens * CLAUDE_HAIKU.output
    : 0
  return { answers, costUsd }
}

function isChoice(q: Question, choice: unknown): choice is string {
  return typeof choice === 'string' && Object.prototype.hasOwnProperty.call(q.criteria, choice)
}

function json(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
