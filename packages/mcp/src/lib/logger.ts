/**
 * Structured logging for b402-mcp.
 *
 * Writes to ~/.b402/mcp.log and stderr. MCP hosts (Claude Desktop / Code)
 * capture stderr but rarely expose it usefully — the file is the durable
 * record. Same pattern as b402-trader's `~/.b402/trader.log`.
 *
 * Sanitizes any field whose key matches a secret pattern (privateKey,
 * mnemonic, signature, password, secret, apiKey, key) so a careless
 * tool author can't leak credentials by passing args verbatim.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_DIR = join(homedir(), '.b402')
const LOG_FILE = join(LOG_DIR, 'mcp.log')

let dirReady = false
function ensureDir(): void {
  if (dirReady) return
  if (!existsSync(LOG_DIR)) {
    try {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    } catch {
      /* fs not writable — fall back to stderr only */
    }
  }
  dirReady = true
}

const SECRET_KEY_RE = /private[_-]?key|mnemonic|signature|password|secret|api[_-]?key|^key$/i

function sanitize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(sanitize)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    out[k] = sanitize(v)
  }
  return out
}

export function log(msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString()
  const tail = fields ? ' ' + JSON.stringify(sanitize(fields)) : ''
  const line = `[${ts}] ${msg}${tail}\n`
  try {
    ensureDir()
    appendFileSync(LOG_FILE, line)
  } catch {
    /* ignore — stderr is the fallback */
  }
  process.stderr.write(line)
}

/**
 * Wrap an async tool handler so every call is bracketed in the log with
 * its arguments, latency, success/failure, and the result hash if any.
 *
 *   server.tool('lend_privately', desc, schema, withLog('lend_privately', async (args) => { ... }))
 */
export function withLog<A, R>(
  toolName: string,
  handler: (args: A) => Promise<R>,
): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    const start = Date.now()
    log(`tool=${toolName} start`, { args: args as unknown })
    try {
      const result = await handler(args)
      const elapsed = Date.now() - start
      // Best-effort extraction of a tx hash from common MCP result shapes
      const text =
        typeof result === 'object' && result !== null
          ? (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
          : ''
      const txMatch = /0x[a-f0-9]{64}/i.exec(text || '')
      const isErr =
        typeof result === 'object' && result !== null
          ? Boolean((result as { isError?: boolean }).isError)
          : false
      log(`tool=${toolName} ${isErr ? 'error' : 'ok'} elapsed_ms=${elapsed}`, {
        tx: txMatch?.[0],
      })
      return result
    } catch (err) {
      const elapsed = Date.now() - start
      log(`tool=${toolName} threw elapsed_ms=${elapsed}`, {
        message: (err as Error).message,
      })
      throw err
    }
  }
}

export const LOG_PATH = LOG_FILE
