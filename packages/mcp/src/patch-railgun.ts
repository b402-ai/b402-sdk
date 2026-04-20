#!/usr/bin/env node
/**
 * Runtime patch for Railgun packages.
 *
 * Two things need patching:
 * 1. EXPORTS: All @railgun-community/* packages restrict subpath imports.
 *    We open ./dist/* wildcard so the SDK can import internal modules.
 * 2. BASE NETWORK: The upstream shared-models has no Base network.
 *    We run the SDK's patch-railgun-sdk.cjs to add Base_Mainnet.
 *
 * Runs at MCP startup, not just postinstall — handles stale installs.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { createRequire } from 'module'
import { execSync } from 'child_process'

const require = createRequire(import.meta.url)
const scriptDir = dirname(new URL(import.meta.url).pathname)

// ── 1. Patch exports ────────────────────────────────────────────────

function patchExports(pkgDir: string): boolean {
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return false

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (!pkg.name?.startsWith('@railgun-community/')) return false
  if (pkg.exports?.['./dist/*']) return false // already patched

  let mainExport = pkg.exports?.['.'] || pkg.main || './dist/index.js'
  if (typeof mainExport === 'string' && !mainExport.startsWith('./')) {
    mainExport = './' + mainExport
  }
  pkg.exports = {
    '.': mainExport,
    './*': './*.js',
    './dist/*': './dist/*.js',
    './dist/**/*': './dist/**/*.js',
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  return true
}

function patchAllExports(baseDir: string) {
  // Direct @railgun-community/*
  const rcDir = join(baseDir, 'node_modules', '@railgun-community')
  if (existsSync(rcDir)) {
    try { for (const e of readdirSync(rcDir)) patchExports(join(rcDir, e)) } catch {}
  }
  // Nested in each railgun package
  if (existsSync(rcDir)) {
    try {
      for (const e of readdirSync(rcDir)) {
        const nested = join(rcDir, e, 'node_modules', '@railgun-community')
        if (existsSync(nested)) {
          for (const n of readdirSync(nested)) patchExports(join(nested, n))
        }
      }
    } catch {}
  }
  // Nested in SDK
  const sdkNested = join(baseDir, 'node_modules', '@b402ai', 'sdk', 'node_modules', '@railgun-community')
  if (existsSync(sdkNested)) {
    try { for (const e of readdirSync(sdkNested)) patchExports(join(sdkNested, e)) } catch {}
  }
}

// Also patch snarkjs
function patchSnarkjs() {
  try {
    const snarkPath = dirname(require.resolve('snarkjs/package.json'))
    const pkgPath = join(snarkPath, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.name === 'snarkjs' && !pkg.exports?.['.']?.require) {
      pkg.exports = {
        '.': { browser: './build/browser.esm.js', import: './main.js', require: './build/main.cjs', default: './build/browser.esm.js' },
      }
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    }
  } catch {}
}

// ── 2. Patch Base network config ────────────────────────────────────

function patchBaseNetwork() {
  try {
    const sdkPkg = require.resolve('@b402ai/sdk/package.json')
    const sdkDir = dirname(sdkPkg)
    const patchScript = join(sdkDir, 'scripts', 'patch-railgun-sdk.cjs')
    if (!existsSync(patchScript)) return

    // Find the top-level node_modules root (walk up from SDK)
    let nmRoot = sdkDir
    while (nmRoot.includes('node_modules')) {
      nmRoot = resolve(nmRoot, '..')
    }
    execSync(`node "${patchScript}"`, { stdio: 'pipe', cwd: nmRoot })
  } catch {}
}

// ── Run all patches ─────────────────────────────────────────────────

// Search from multiple roots
const roots = new Set([
  join(scriptDir, '..'),                    // MCP package root
  process.cwd(),                            // current working directory
  join(scriptDir, '..', '..', '..'),        // repo root (dev mode)
])
for (const root of roots) patchAllExports(root)

// Direct resolve fallback
for (const pkg of ['engine', 'wallet', 'shared-models', 'circomlibjs', 'poseidon-hash-wasm', 'ffjavascript', 'curve25519-scalarmult-wasm']) {
  try { patchExports(dirname(require.resolve(`@railgun-community/${pkg}/package.json`))) } catch {}
}

patchSnarkjs()
patchBaseNetwork()
