#!/usr/bin/env node
/**
 * Patches @railgun-community/shared-models to add Base_Mainnet network support.
 *
 * The Railgun SDK has no native Base support. This script adds Base_Mainnet to:
 * - NetworkName enum
 * - All 8 contract/config maps
 * - NETWORK_CONFIG object
 *
 * Must patch BOTH copies in pnpm:
 * - v6.4.7 (used by @railgun-community/wallet)
 * - v8.0.0 (used by direct imports)
 *
 * Run via: node scripts/patch-railgun-sdk.js
 * Auto-runs via: package.json "postinstall" hook
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// B402 fork contract addresses on Base
const BASE_CONFIG = {
  proxyContract: '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85',
  relayAdaptContract: '0xB0BC6d50098519c2a030661338F82a8792b85404',
  deploymentBlock: 42170000,
  weth: '0x4200000000000000000000000000000000000006',
  chainId: 8453,
}

function findNetworkConfigFiles() {
  const files = []

  // Search multiple node_modules locations (handles hoisting)
  const searchDirs = [
    path.join(__dirname, '..', 'node_modules'),           // SDK's own
    path.join(__dirname, '..', '..', '..', 'node_modules'), // hoisted (when SDK is a dep)
    path.join(process.cwd(), 'node_modules'),               // cwd
  ]

  for (const nodeModules of searchDirs) {
    if (!fs.existsSync(nodeModules)) continue
    findInNodeModules(nodeModules, files)
  }

  if (files.length === 0) {
    console.log('[patch-sdk] No @railgun-community/shared-models found')
  } else {
    console.log(`[patch-sdk] Found ${files.length} copies to patch`)
  }

  return files
}

function findInNodeModules(nodeModules, files) {
  if (!fs.existsSync(nodeModules)) return

  // Flat structure
  const flatPath = path.join(nodeModules, '@railgun-community', 'shared-models', 'dist', 'models', 'network-config.js')
  if (fs.existsSync(flatPath) && !files.includes(flatPath)) files.push(flatPath)

  // Nested inside wallet
  const walletPath = path.join(nodeModules, '@railgun-community', 'wallet', 'node_modules', '@railgun-community', 'shared-models', 'dist', 'models', 'network-config.js')
  if (fs.existsSync(walletPath) && !files.includes(walletPath)) files.push(walletPath)

  // Nested inside engine
  const enginePath = path.join(nodeModules, '@railgun-community', 'engine', 'node_modules', '@railgun-community', 'shared-models', 'dist', 'models', 'network-config.js')
  if (fs.existsSync(enginePath) && !files.includes(enginePath)) files.push(enginePath)

  // Nested inside SDK
  const sdkPath = path.join(nodeModules, '@b402ai', 'sdk', 'node_modules', '@railgun-community', 'shared-models', 'dist', 'models', 'network-config.js')
  if (fs.existsSync(sdkPath) && !files.includes(sdkPath)) files.push(sdkPath)

  // pnpm
  const pnpmDir = path.join(nodeModules, '.pnpm')
  if (fs.existsSync(pnpmDir)) {
    try {
      for (const entry of fs.readdirSync(pnpmDir)) {
        if (!entry.startsWith('@railgun-community+shared-models@')) continue
        const configPath = path.join(pnpmDir, entry, 'node_modules', '@railgun-community', 'shared-models', 'dist', 'models', 'network-config.js')
        if (fs.existsSync(configPath) && !files.includes(configPath)) files.push(configPath)
      }
    } catch {}
  }
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8')

  // Check if already patched
  if (content.includes('Base_Mainnet')) {
    console.log(`[patch-sdk] Already patched: ${path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(filePath))))))}`)
    return false
  }

  console.log(`[patch-sdk] Patching: ${filePath}`)

  // 1. Add Base to NetworkName enum
  // Insert after the last mainnet entry (Arbitrum)
  content = content.replace(
    /NetworkName\["Arbitrum"\] = "Arbitrum";/,
    `NetworkName["Arbitrum"] = "Arbitrum";\n    // B402 additions\n    NetworkName["Base"] = "Base_Mainnet";`
  )

  // 2. Add Base to RailgunProxyContract
  content = content.replace(
    /(\[NetworkName\.Arbitrum\]: '[^']*',\n)(.*\/\/ Test nets)/,
    `$1    [NetworkName.Base]: '${BASE_CONFIG.proxyContract}',\n$2`
  )

  // 3. Add Base to RelayAdaptContract
  content = content.replace(
    /(\[NetworkName\.Arbitrum\]: '[^']*',\n)(.*\/\/ Test nets)/,
    `$1    [NetworkName.Base]: '${BASE_CONFIG.relayAdaptContract}',\n$2`
  )

  // 4. Add Base to RailgunProxyDeploymentBlock
  content = content.replace(
    /(\[NetworkName\.Arbitrum\]: \d+,\n)(.*\/\/ Test nets)/,
    `$1    [NetworkName.Base]: ${BASE_CONFIG.deploymentBlock},\n$2`
  )

  // 5. Add Base to BaseTokenWrappedAddress
  content = content.replace(
    /(\[NetworkName\.Arbitrum\]: '[^']*',\n)(.*\/\/ Test nets)/,
    `$1    [NetworkName.Base]: '${BASE_CONFIG.weth}',\n$2`
  )

  // 6-8. Add Base to V3 maps and new 8.0.1 maps (empty strings since we use V2)
  const emptyMaps = [
    'RailgunPoseidonMerkleAccumulatorV3Contract',
    'RailgunPoseidonMerkleVerifierV3Contract',
    'RailgunTokenVaultV3Contract',
    'RailgunPoseidonMerkleAccumulatorV3DeploymentBlock',
    // New in shared-models 8.0.1:
    'RailgunRegistryContract',
    'RelayAdapt7702Contract',
  ]

  for (const mapName of emptyMaps) {
    // For deployment block map, use 0; for contract maps, use empty string
    const value = mapName.includes('DeploymentBlock') ? '0' : "''"
    const pattern = new RegExp(
      `(exports\\.${mapName} = \\{[\\s\\S]*?\\[NetworkName\\.Arbitrum\\]: [^,]+,\\n)(\\s*\\/\\/ Test nets)`
    )
    if (pattern.test(content)) {
      content = content.replace(pattern, `$1    [NetworkName.Base]: ${value},\n$2`)
    }
  }

  // 9. Add Base to NETWORK_CONFIG (insert after Arbitrum block)
  const baseNetworkConfig = `    [NetworkName.Base]: {
        chain: {
            type: response_types_1.ChainType.EVM,
            id: ${BASE_CONFIG.chainId},
        },
        name: NetworkName.Base,
        publicName: 'Base',
        shortPublicName: 'Base',
        coingeckoId: 'base',
        baseToken: {
            symbol: 'ETH',
            wrappedSymbol: 'WETH',
            wrappedAddress: exports.BaseTokenWrappedAddress[NetworkName.Base],
            decimals: 18,
        },
        proxyContract: exports.RailgunProxyContract[NetworkName.Base],
        relayAdaptContract: exports.RelayAdaptContract[NetworkName.Base],
        relayAdaptHistory: [
            '${BASE_CONFIG.relayAdaptContract}',
        ],
        deploymentBlock: exports.RailgunProxyDeploymentBlock[NetworkName.Base],
        defaultEVMGasType: response_types_1.EVMGasType.Type2,
        poseidonMerkleAccumulatorV3Contract: exports.RailgunPoseidonMerkleAccumulatorV3Contract[NetworkName.Base],
        poseidonMerkleVerifierV3Contract: exports.RailgunPoseidonMerkleVerifierV3Contract[NetworkName.Base],
        tokenVaultV3Contract: exports.RailgunTokenVaultV3Contract[NetworkName.Base],
        deploymentBlockPoseidonMerkleAccumulatorV3: exports.RailgunPoseidonMerkleAccumulatorV3DeploymentBlock[NetworkName.Base],
        relayAdapt7702Contract: exports.RelayAdapt7702Contract ? exports.RelayAdapt7702Contract[NetworkName.Base] : '',
        railgunRegistryContract: exports.RailgunRegistryContract ? exports.RailgunRegistryContract[NetworkName.Base] : '',
        supportsV3: false,
    },`

  // Insert after the Arbitrum NETWORK_CONFIG block (find the closing },)
  // Look for the Arbitrum config block end and insert Base after it
  const arbitrumConfigEnd = content.indexOf("supportsV3: false,\n    },", content.indexOf("[NetworkName.Arbitrum]: {"))
  if (arbitrumConfigEnd !== -1) {
    const insertPoint = content.indexOf("},", arbitrumConfigEnd + "supportsV3: false,\n    ".length) + 2
    content = content.slice(0, insertPoint) + '\n' + baseNetworkConfig + content.slice(insertPoint)
  }

  fs.writeFileSync(filePath, content)
  console.log(`[patch-sdk] Patched successfully`)
  return true
}

/**
 * Remove stale nested @railgun-community packages inside wallet/engine.
 *
 * npm sometimes installs old versions (shared-models@6.4.x, engine@8.x)
 * inside wallet's node_modules. The wallet then uses those stale copies
 * instead of our patched top-level ones, causing loadProvider to hang.
 *
 * This ensures every package resolves to the single top-level version.
 */
function removeNestedRailgunDeps() {
  const nodeModules = path.join(__dirname, '..', 'node_modules')
  const parentPackages = ['wallet', 'engine']
  let removed = 0

  for (const pkg of parentPackages) {
    const nestedDir = path.join(
      nodeModules, '@railgun-community', pkg,
      'node_modules', '@railgun-community'
    )
    if (fs.existsSync(nestedDir)) {
      fs.rmSync(nestedDir, { recursive: true, force: true })
      console.log(`[patch-sdk] Removed nested @railgun-community from ${pkg}`)
      removed++
    }
  }

  if (removed === 0) {
    console.log('[patch-sdk] No stale nested deps found')
  }
}

// Main
removeNestedRailgunDeps()

const files = findNetworkConfigFiles()

if (files.length === 0) {
  console.log('[patch-sdk] No @railgun-community/shared-models found to patch')
  process.exit(0)
}

let patchCount = 0
for (const file of files) {
  try {
    if (patchFile(file)) patchCount++
  } catch (err) {
    console.error(`[patch-sdk] Error patching ${file}:`, err.message)
  }
}

console.log(`[patch-sdk] Done. ${patchCount} file(s) patched, ${files.length - patchCount} already up to date.`)
