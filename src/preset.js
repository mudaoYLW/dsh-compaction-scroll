import { Service } from '@deepseek-ai/cordis'
import { createMinimalNotesPreset } from '../presets/minimal-notes.js'
import { Config, resolveConfig } from './config.js'

/** Add a roster entry without changing the user's default or preset files. */
export default class MinimalNotesPreset {
  static inject = ['agentPresets']
  static Config = Config

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = resolveConfig(config)
  }

  async *[Service.init]() {
    // The registry owns revision lifetimes; Cordis owns this registration lease.
    yield await this.ctx.agentPresets.register(createMinimalNotesPreset(this.config))
  }
}
