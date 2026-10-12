import z from '@deepseek-ai/schemastery'
import { notePath } from './state.js'

/** Limits apply per session; the working budget must fit inside the model window. */
export const Config = z.object({
  contextBudgetTokens: z.number().step(1).min(1024).default(64000),
  reminderTokens: z.number().step(1).min(1).default(8000),
  checkpointPath: z.string().default('handoff.md'),
  maxCheckpointChars: z.number().step(1).min(1).default(16000),
  maxNoteBytes: z.number().step(1).min(1).default(65536),
  maxNotes: z.number().step(1).min(1).default(64),
  maxTotalNoteBytes: z.number().step(1).min(1).default(262144),
  maxResults: z.number().step(1).min(1).default(20),
  maxOutputChars: z.number().step(1).min(256).default(12000),
})

/** Resolve direct programmatic use as well as Cordis configuration. */
export function resolveConfig(input = {}) {
  const config = Config(input)
  if (config.reminderTokens >= config.contextBudgetTokens) {
    throw new Error('reminderTokens must be smaller than contextBudgetTokens')
  }
  if (config.maxCheckpointChars > config.maxNoteBytes) {
    throw new Error('maxCheckpointChars must not exceed maxNoteBytes')
  }
  if (config.maxNoteBytes > config.maxTotalNoteBytes) {
    throw new Error('maxNoteBytes must not exceed maxTotalNoteBytes')
  }
  notePath(config.checkpointPath)
  return config
}
