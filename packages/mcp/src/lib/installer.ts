/**
 * Universal MCP installer — auto-detects and configures ALL MCP clients.
 * Config paths verified against agentcash@0.13.6 (the reference implementation).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, platform } from 'os'
import { execSync } from 'child_process'
import { getOwnVersion } from './version.js'

const home = homedir()

// Pin the host config to the version of MCP that was just executed, not
// to '@latest'. Running `npx b402-mcp@next --claude` then has the host
// spawn the same prerelease, not the stable tag.
const MCP_ENTRY = {
  command: 'npx',
  args: ['-y', `b402-mcp@${getOwnVersion()}`],
}

function getBaseDir(): string {
  if (platform() === 'win32') {
    return process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support')
  }
  return join(home, '.config')
}

function getVsCodePath(): string {
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User')
  if (platform() === 'win32') return join(getBaseDir(), 'Code', 'User')
  return join(home, '.config', 'Code', 'User')
}

interface ClientDef {
  name: string
  configPath: string
  mcpKey?: string // key in the config JSON (default: 'mcpServers')
}

function getClients(): ClientDef[] {
  const baseDir = getBaseDir()
  const vscodePath = getVsCodePath()

  return [
    {
      name: 'Claude Code',
      configPath: join(home, '.claude.json'),
    },
    {
      name: 'Claude Desktop',
      configPath: join(baseDir, 'Claude', 'claude_desktop_config.json'),
    },
    {
      name: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
    },
    {
      name: 'Windsurf',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    },
    {
      name: 'Cline',
      configPath: join(vscodePath, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    },
    {
      name: 'OpenCode',
      configPath: join(home, '.config', 'opencode', 'opencode.json'),
    },
    {
      name: 'Gemini CLI',
      configPath: join(home, '.gemini', 'settings.json'),
    },
  ]
}

function readJsonSafe(path: string): any {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJsonSafe(path: string, data: any) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

export function installToAllClients(): string[] {
  const results: string[] = []
  const clients = getClients()

  for (const client of clients) {
    // Only install if the parent directory exists (client is installed)
    const parentDir = dirname(client.configPath)
    // For Claude Code, check the file itself since ~/.claude.json is at home root
    const isInstalled = client.name === 'Claude Code'
      ? existsSync(client.configPath) || !!process.env.CLAUDECODE
      : existsSync(parentDir)

    if (!isInstalled) continue

    try {
      const config = readJsonSafe(client.configPath) || {}
      if (!config.mcpServers) config.mcpServers = {}

      const existing = config.mcpServers.b402
      // Upgrade-friendly: if the existing entry is the npx-managed b402-mcp
      // launcher, rewrite it so a `b402-mcp@<newer> --claude` always points
      // hosts at the freshly-installed version. Custom command paths
      // (e.g. local-dev `node /path/to/dist/index.js`) are left untouched.
      const isManagedEntry =
        existing &&
        existing.command === 'npx' &&
        Array.isArray(existing.args) &&
        existing.args.some((a: string) => typeof a === 'string' && a.startsWith('b402-mcp'))

      if (existing && !isManagedEntry) {
        results.push(`${client.name} (custom config — left as-is)`)
        continue
      }

      // Preserve any env vars the user set on a previous install.
      const preservedEnv = existing?.env
      config.mcpServers.b402 = preservedEnv
        ? { ...MCP_ENTRY, env: preservedEnv }
        : MCP_ENTRY
      writeJsonSafe(client.configPath, config)
      results.push(existing ? `${client.name} ↑ updated` : `${client.name} ✓`)
    } catch (err: any) {
      results.push(`${client.name} (error: ${err.message?.slice(0, 50)})`)
    }
  }

  // Claude Code CLI fallback
  if (process.env.CLAUDECODE && !results.some(r => r.startsWith('Claude Code ✓'))) {
    try {
      execSync('claude mcp add b402 --scope user -- b402-mcp', { stdio: 'pipe' })
      if (!results.some(r => r.startsWith('Claude Code'))) results.push('Claude Code ✓')
    } catch {}
  }

  // Codex — uses TOML at ~/.codex/config.toml
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, '.codex')
  const codexConfig = join(codexHome, 'config.toml')
  if (existsSync(codexConfig)) {
    try {
      const content = readFileSync(codexConfig, 'utf8')
      if (content.includes('[mcp_servers.b402]')) {
        results.push('Codex (already configured)')
      } else {
        const tomlEntry = `\n[mcp_servers.b402]\ncommand = "npx"\nargs = [ "-y", "b402-mcp@${getOwnVersion()}" ]\n`
        writeFileSync(codexConfig, content + tomlEntry)
        results.push('Codex ✓')
      }
    } catch (err: any) {
      results.push(`Codex (error: ${err.message?.slice(0, 50)})`)
    }
  }

  return results
}
