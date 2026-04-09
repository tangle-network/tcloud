/**
 * Instance — programmatic harness for spinning up a local Tangle dev environment.
 *
 * Wraps `cargo tangle harness up` as a child process and exposes health
 * checks, log streaming, and a pre-configured {@link TCloudClient} pointed
 * at the local stack.
 *
 * NODE-ONLY. This module uses `child_process` and `fs` and must not be
 * imported in browser or edge runtime bundles. Always import from
 * `@tangle-network/tcloud/instance`, never the package root.
 *
 * ## Example
 *
 * ```ts
 * import { Instance } from '@tangle-network/tcloud/instance'
 *
 * const instance = await Instance.start({
 *   config: './harness.dev.toml',
 *   only: ['llm'],
 * })
 *
 * const client = instance.client({ model: 'llama-3.1-8b' })
 * const res = await client.chat({
 *   messages: [{ role: 'user', content: 'hello' }],
 * })
 * console.log(res.choices[0].message.content)
 *
 * await instance.stop()
 * ```
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { TCloudClient } from './client'
import type { TCloudConfig } from './types'

export interface InstanceOptions {
  /** Path to harness config TOML. Defaults to ./harness.toml or ~/.tangle/harness.toml */
  config?: string
  /** Only start these blueprints (subset) */
  only?: string[]
  /** Working directory for `cargo tangle harness` (default: current) */
  cwd?: string
  /** Stream anvil logs (default false) */
  includeAnvilLogs?: boolean
  /** Suppress stdout passthrough (default false) */
  quiet?: boolean
  /** Startup timeout in ms — how long to wait for "Harness up" marker (default 300_000) */
  timeoutMs?: number
  /** Router URL the instance exposes. Defaults to http://localhost:3000 */
  routerUrl?: string
  /** Override the `cargo tangle` binary path. Defaults to resolving `cargo-tangle` from PATH */
  cargoBinary?: string
}

export interface InstanceConfig {
  /** URL of the router the instance is serving on */
  routerUrl: string
  /** Names of blueprints that were started */
  blueprints: string[]
}

const MAX_LOG_LINES = 10_000

/**
 * Append a line to a bounded log buffer, evicting the oldest entry once the
 * buffer exceeds `maxLines`. Exported for unit testing.
 */
export function appendLogLine(
  buffer: string[],
  line: string,
  maxLines: number = MAX_LOG_LINES,
): void {
  buffer.push(line)
  if (buffer.length > maxLines) {
    buffer.shift()
  }
}

/**
 * A running Tangle dev environment. Hold one per test file or dev session.
 */
export class Instance {
  private child: ChildProcess
  private _config: InstanceConfig
  private _stopped = false
  private logBuffer: string[]
  private readonly maxLogLines = MAX_LOG_LINES

  private constructor(
    child: ChildProcess,
    config: InstanceConfig,
    logBuffer: string[],
  ) {
    this.child = child
    this._config = config
    this.logBuffer = logBuffer
  }

  /**
   * Start a new harness instance. Resolves once `cargo tangle harness up`
   * prints its "Harness up" marker, indicating all blueprints are healthy.
   *
   * Throws on timeout, process exit before ready, or missing `cargo-tangle`.
   */
  static async start(options: InstanceOptions = {}): Promise<Instance> {
    const cargoBinary = options.cargoBinary ?? 'cargo-tangle'
    const timeoutMs = options.timeoutMs ?? 300_000
    const routerUrl = options.routerUrl ?? 'http://localhost:3000'

    const args: string[] = ['tangle', 'harness', 'up']
    if (options.config) {
      args.push('--config', options.config)
    }
    if (options.only && options.only.length > 0) {
      args.push('--only', options.only.join(','))
    }
    if (options.includeAnvilLogs) {
      args.push('--include-anvil-logs')
    }

    const child = spawn(cargoBinary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Single, persistent log buffer. The Instance returned at the end of
    // start() inherits this same reference — no second listener is attached
    // post-startup, so lines are recorded exactly once.
    const logBuffer: string[] = []

    const pushLog = (line: string) => {
      appendLogLine(logBuffer, line, MAX_LOG_LINES)
      if (!options.quiet) {
        process.stdout.write(line + '\n')
      }
    }

    let stdoutTail = ''
    let stderrTail = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutTail += chunk.toString()
      const lines = stdoutTail.split('\n')
      stdoutTail = lines.pop() ?? ''
      for (const line of lines) pushLog(line)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString()
      const lines = stderrTail.split('\n')
      stderrTail = lines.pop() ?? ''
      for (const line of lines) pushLog(line)
    })

    // Wait for the "Harness up" marker in stdout
    const blueprintNames: string[] = []

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let pollInterval: ReturnType<typeof setInterval> | undefined

        // Single cleanup path called from every settle branch (resolve,
        // timeout, exit, error). Clears both timers and both listeners so
        // nothing leaks once the promise is done.
        const cleanup = () => {
          if (settled) return
          settled = true
          if (pollInterval !== undefined) clearInterval(pollInterval)
          if (timer !== undefined) clearTimeout(timer)
          child.removeListener('exit', onExit)
          child.removeListener('error', onError)
        }

        const onExit = (code: number | null) => {
          if (settled) return
          cleanup()
          reject(
            new Error(
              `cargo tangle harness exited with code ${code} before becoming ready. ` +
                `Last 20 lines:\n${logBuffer.slice(-20).join('\n')}`,
            ),
          )
        }

        const onError = (err: Error) => {
          if (settled) return
          cleanup()
          reject(new Error(`Failed to spawn ${cargoBinary}: ${err.message}`))
        }

        timer = setTimeout(() => {
          if (settled) return
          cleanup()
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for harness to start. ` +
                `Last 20 lines:\n${logBuffer.slice(-20).join('\n')}`,
            ),
          )
        }, timeoutMs)

        child.once('exit', onExit)
        child.once('error', onError)

        // Poll the logBuffer for the "Harness up" marker
        pollInterval = setInterval(() => {
          for (const line of logBuffer) {
            const match = line.match(/Harness up\.\s+(\d+)\s+blueprint/i)
            if (match) {
              if (settled) return
              cleanup()
              resolve()
              return
            }
            const bpMatch = line.match(/Starting blueprint-manager for '([^']+)'/)
            if (bpMatch) {
              blueprintNames.push(bpMatch[1])
            }
          }
        }, 100)
      })
    } catch (err) {
      // Ensure the child is dead if startup failed
      if (!child.killed) {
        child.kill('SIGTERM')
      }
      throw err
    }

    // Instance shares the same logBuffer reference the stdout/stderr
    // listeners already write to — no new listeners needed.
    return new Instance(
      child,
      { routerUrl, blueprints: blueprintNames },
      logBuffer,
    )
  }

  /** URL of the router serving this instance */
  get routerUrl(): string {
    return this._config.routerUrl
  }

  /** Names of blueprints that were started */
  get blueprints(): string[] {
    return [...this._config.blueprints]
  }

  /**
   * Create a pre-configured {@link TCloudClient} pointed at this instance's router.
   * Merges any passed config with the instance's routerUrl (instance wins).
   */
  client(config: Partial<TCloudConfig> = {}): TCloudClient {
    return new TCloudClient({
      ...config,
      baseURL: this._config.routerUrl,
    })
  }

  /** Return the last N log lines from the harness */
  logs(lines = 100): string[] {
    return this.logBuffer.slice(-lines)
  }

  /** Whether the harness process is still running */
  get isRunning(): boolean {
    // _stopped is checked first: after stop() sends SIGTERM the child's
    // exitCode stays null until the 'exit' event fires, so relying on
    // exitCode alone would briefly report a stopped instance as running.
    return !this._stopped && !this.child.killed && this.child.exitCode === null
  }

  /**
   * Stop the harness. Sends SIGTERM, waits up to 10s for clean shutdown,
   * then SIGKILL.
   */
  async stop(timeoutMs = 10_000): Promise<void> {
    if (this._stopped) return
    this._stopped = true

    if (this.child.exitCode !== null) {
      // Already exited
      return
    }

    this.child.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) {
          this.child.kill('SIGKILL')
        }
        resolve()
      }, timeoutMs)

      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/**
 * Write a temporary harness.toml with the given blueprints, for inline test configs.
 * Returns the path to the created file. The caller is responsible for cleanup.
 */
export function writeTempHarnessConfig(blueprints: Array<{
  name: string
  path: string
  port?: number
  env?: Record<string, string>
}>): string {
  // PID + Date.now() collides if the same process calls this twice within
  // the same millisecond. randomUUID() guarantees uniqueness.
  const dir = join(
    tmpdir(),
    `tangle-harness-${process.pid}-${Date.now()}-${randomUUID()}`,
  )
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const file = join(dir, 'harness.toml')

  const lines: string[] = []
  lines.push('[chain]')
  lines.push('anvil = true')
  lines.push('')
  for (const bp of blueprints) {
    lines.push('[[blueprint]]')
    lines.push(`name = "${bp.name}"`)
    lines.push(`path = "${bp.path}"`)
    if (bp.port !== undefined) {
      lines.push(`port = ${bp.port}`)
    }
    if (bp.env) {
      for (const [k, v] of Object.entries(bp.env)) {
        lines.push(`env.${k} = "${v.replace(/"/g, '\\"')}"`)
      }
    }
    lines.push('')
  }

  writeFileSync(file, lines.join('\n'))
  return file
}
