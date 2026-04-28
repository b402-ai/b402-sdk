import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

let cached: string | null = null

/**
 * Read this package's own version from package.json. Used for:
 *  - the McpServer version constant (so hosts report the real version)
 *  - the npx args we write into MCP host configs (so hosts spawn the same
 *    version that just ran the installer, not @latest)
 */
export function getOwnVersion(): string {
  if (cached) return cached
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // dist/lib/version.js → ../../package.json
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))
    cached = pkg.version || 'unknown'
    return cached!
  } catch {
    cached = 'unknown'
    return cached
  }
}
