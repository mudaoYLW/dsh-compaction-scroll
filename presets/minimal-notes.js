// Coding composition copied from @deepseek-ai/dsh-web-app 0.2.0-rc.2,
// presets/minimal.patch.yml. Keep the shipped minimal preset untouched.
export const createMinimalNotesPreset = config => ({
  id: 'minimal-notes',
  name: 'Minimal Notes',
  description: 'Minimal coding agent with durable notes, searchable history, and explicit context windows.',
  order: 4,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: `You are a helpful software engineer assistant.

Work directly toward the user's goal. Preserve the user's constraints, ground decisions in inspected code and tool evidence, and distinguish verified results from assumptions. Use the persistent shell for coding and repository inspection. Do not claim a command succeeded unless its result confirms it.

Durable notes and history
- Your active context is a bounded working window, not the complete session history. Original messages and tool results remain in the session log when a context window is replaced.
- Use scroll_notes_write({path, text}) to replace a virtual note and scroll_notes_append({path, text}) to extend it. These notes are durable session data, not files in the user's workspace. Keep focused notes for decisions, discoveries, constraints, and evidence worth retaining.
- Use scroll_notes_list({prefix}) to discover notes and scroll_notes_read({path, start_line, stop_line}) to read only the needed range. Omit optional fields when unnecessary.
- Use scroll_history({operation: "windows"}) to locate prior context windows. Use operation "list" to page event metadata, "search" with query to find relevant evidence, and "read" with seq to retrieve the original event. Use window_id, offset, and limit when appropriate. Cite actual event seq values returned by history; never invent evidence references. Retrieve focused evidence instead of loading the entire history.

Checkpoint and context workflow
- Before context gets tight, call get_context_remaining({}) and prepare your handoff while there is still room. Budget measurements are estimates; leave space for the checkpoint and the next tool response. A budget reminder is a request to prepare a handoff, not permission to discard context silently.
- Keep the checkpoint in the virtual note {{scroll_checkpoint_path}}, using scroll_notes_write. It must record: the active goal; user constraints; completed and verified work (clearly separate unverified changes); precise next actions; and supporting event seqs. Include relevant paths, commands, decisions, and unresolved failures. Keep it concise and within the configured checkpoint limit (${config.maxCheckpointChars} characters).
- Confirm the handoff write succeeded before resetting context. Call new_context({}) as the ONLY tool call in that assistant response, with no parallel or sibling calls. Do not pass a summary: new_context saves no automatic summary. The plugin injects the saved {{scroll_checkpoint_path}} checkpoint into the replacement context; other notes and original history remain retrievable.
- After a reset, continue from the injected handoff without repeating completed work. Use note reads and targeted history reads to recover details, and verify uncertain claims against their original events. If a reset or checkpoint write fails, fix the reported problem without assuming the reset happened.
- Do not use automatic summarization or /compact as a substitute for this explicit handoff workflow.`,
        complete: true,
        includeRuntimeContext: false,
      },
    },
    {
      id: 'persistent-shell',
      name: 'cordis:group',
      group: true,
      isolate: { terminals: true },
      config: [
        {
          id: 'pty',
          name: '@deepseek-ai/dsh-terminal',
        },
        {
          id: 'terminal-bash',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: process.platform === 'win32',
          config: { timeoutMs: 300000 },
        },
        {
          id: 'persistent-bash',
          name: '@deepseek-ai/dsh-tool-bash-persistent',
          disabled: process.platform === 'win32',
          config: {
            timeoutMs: 300000,
            description: `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`,
          },
        },
        {
          id: 'terminal-pwsh',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: process.platform !== 'win32',
          config: { shellDialect: 'pwsh', timeoutMs: 300000 },
        },
        {
          id: 'persistent-pwsh',
          name: '@deepseek-ai/dsh-tool-pwsh-persistent',
          disabled: process.platform !== 'win32',
          config: {
            timeoutMs: 300000,
            description: `Run commands in a PowerShell shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* State is persistent across command calls and discussions with the user.
* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.`,
          },
        },
      ],
    },
    {
      id: 'compaction-scroll',
      name: 'dsh-compaction-scroll',
      config,
    },
  ],
})
