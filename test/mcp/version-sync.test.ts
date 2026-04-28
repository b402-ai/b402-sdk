import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const PKG = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'packages', 'mcp', 'package.json'), 'utf8'),
)

describe('mcp version sync', () => {
  it('package.json version is real semver', () => {
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/)
  })

  it('getOwnVersion() returns the package.json version', async () => {
    const { getOwnVersion } = await import(
      '../../packages/mcp/src/lib/version'
    )
    expect(getOwnVersion()).toBe(PKG.version)
  })

  it('McpServer version constant is not the legacy 0.5.0 placeholder', async () => {
    // Read the source file directly — the real assertion is "no drift",
    // not "exactly equal to package.json" because index.ts imports the
    // version helper at runtime, so we verify the helper is wired in.
    const src = readFileSync(
      join(__dirname, '..', '..', 'packages', 'mcp', 'src', 'index.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/version:\s*['"]0\.5\.0['"]/)
    // And that it imports getOwnVersion from the helper.
    expect(src).toMatch(/getOwnVersion/)
  })

  it('installer never writes b402-mcp@latest — every entry pins own version', async () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'packages', 'mcp', 'src', 'lib', 'installer.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/b402-mcp@latest/)
    // And it does interpolate the version helper for the install entries.
    expect(src).toMatch(/b402-mcp@\$\{/)
  })
})
