/**
 * Client-Side ZK Prover
 *
 * Generates Groth16 proofs using snarkjs in the browser.
 * Circuit artifacts are cached in IndexedDB after first download.
 *
 * Ported from backend: utils/railgun-core/proof/prover.ts
 */

import { ethers } from 'ethers'
import type { PrivateInputsRailgun, PublicInputsRailgun } from './proof-inputs'
import type { CommitmentCiphertext } from './note-encryption'
// Import from main package where available
import { ByteUtils } from '@railgun-community/engine'
// Import from subpaths (pnpm.packageExtensions in package.json extends exports)
import { keccak256 } from '@railgun-community/engine/dist/utils/hash'
import { poseidon } from '@railgun-community/engine/dist/utils/poseidon'
import { signEDDSA } from '@railgun-community/engine/dist/utils/keys-utils'
import { SNARK_PRIME } from '@railgun-community/engine/dist/utils/constants'

// Artifact IPFS URL (Railgun official via IPFS gateway)
const IPFS_GATEWAY = 'https://ipfs-lb.com'
const MASTER_IPFS_HASH = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'

export interface Proof {
  pi_a: [string, string]
  pi_b: [[string, string], [string, string]]
  pi_c: [string, string]
}

export interface GenerateProofParams {
  privateInputs: PrivateInputsRailgun
  publicInputs: PublicInputsRailgun
  spendingPrivateKey: Uint8Array
  chainId: number
  treeNumber: number
  /** Number of outputs: 1 for full unshield (01x01), 2 for partial unshield with change (01x02) */
  outputCount?: 1 | 2
  /** Commitment ciphertext for change notes (required for partial unshield with outputCount=2) */
  commitmentCiphertext?: CommitmentCiphertext[]
  /** If true, this is a pure transact (no unshield) - sets unshield=0 in boundParams */
  isTransact?: boolean
  /** Adapt contract address for cross-contract calls via RelayAdapt (default: ZeroAddress) */
  adaptContract?: string
  /** Adapt parameters hash for cross-contract calls (default: ZeroHash) */
  adaptParams?: string
  onProgress?: (progress: number, status: string) => void
}

export interface ProofResult {
  proof: Proof
  publicInputs: PublicInputsRailgun
  /** The bound params used for proof generation (includes commitmentCiphertext) */
  boundParams: BoundParamsV2
}

/**
 * Bound parameters structure for V2 transactions
 * This is included in the ZK proof and verified by the contract
 */
export interface BoundParamsV2 {
  treeNumber: number
  minGasPrice: number
  unshield: number
  chainID: string
  adaptContract: string
  adaptParams: string
  commitmentCiphertext: CommitmentCiphertext[]
}

/**
 * Decompress brotli-compressed data
 */
async function decompressBrotli(compressedData: ArrayBuffer): Promise<ArrayBuffer> {
  // Try using the brotli package (same as Railgun SDK)
  try {
    // @ts-ignore - brotli package doesn't have type definitions
    const brotli = await import('brotli/decompress')
    const decompressed = brotli.default(Buffer.from(compressedData))
    return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength)
  } catch {
    // If brotli not available, try DecompressionStream (modern browsers)
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate')
      const blob = new Blob([compressedData])
      const decompressedStream = blob.stream().pipeThrough(ds)
      const decompressedBlob = await new Response(decompressedStream).blob()
      return decompressedBlob.arrayBuffer()
    }
    throw new Error('No decompression method available')
  }
}

/**
 * Get or download circuit artifacts
 * Uses IndexedDB for persistent caching
 * @param outputCount - Number of outputs: 1 uses 01x01 circuit, 2 uses 01x02 circuit
 */
async function getCircuitArtifacts(
  outputCount: 1 | 2 = 1,
  onProgress?: (progress: number, status: string) => void
): Promise<{ wasm: ArrayBuffer; zkey: ArrayBuffer }> {
  const { createIndexedDBArtifactStore } = await import('./artifact-store')
  const store = await createIndexedDBArtifactStore()

  // Select circuit based on output count
  // 01x01 = 1 input, 1 output (full unshield)
  // 01x02 = 1 input, 2 outputs (partial unshield with change)
  const circuitName = outputCount === 2 ? '01x02' : '01x01'
  const wasmPath = `artifacts-v2.1/${circuitName}/wasm`
  const zkeyPath = `artifacts-v2.1/${circuitName}/zkey`

  // Check if already cached
  const wasmCached = await store.exists(wasmPath)
  const zkeyCached = await store.exists(zkeyPath)

  let wasm: ArrayBuffer
  let zkey: ArrayBuffer

  if (wasmCached && zkeyCached) {
    onProgress?.(5, 'Loading cached circuit artifacts...')
    const wasmData = await store.get(wasmPath)
    const zkeyData = await store.get(zkeyPath)

    // Convert to ArrayBuffer if needed
    wasm = wasmData instanceof ArrayBuffer ? wasmData : new Uint8Array(wasmData as Buffer).buffer
    zkey = zkeyData instanceof ArrayBuffer ? zkeyData : new Uint8Array(zkeyData as Buffer).buffer
  } else {
    // Download from IPFS (brotli compressed)
    onProgress?.(5, 'Downloading circuit artifacts (first time only)...')

    // Railgun stores artifacts on IPFS with brotli compression
    const wasmUrl = `${IPFS_GATEWAY}/ipfs/${MASTER_IPFS_HASH}/prover/snarkjs/${circuitName}.wasm.br`
    const zkeyUrl = `${IPFS_GATEWAY}/ipfs/${MASTER_IPFS_HASH}/circuits/${circuitName}/zkey.br`

    onProgress?.(10, 'Downloading WASM circuit (~1MB compressed)...')
    const wasmResponse = await fetch(wasmUrl)
    if (!wasmResponse.ok) {
      throw new Error(`Failed to download WASM: ${wasmResponse.status} from ${wasmUrl}`)
    }
    const wasmCompressed = await wasmResponse.arrayBuffer()

    onProgress?.(15, 'Decompressing WASM...')
    wasm = await decompressBrotli(wasmCompressed)

    onProgress?.(20, 'Downloading proving key (~2MB compressed)...')
    const zkeyResponse = await fetch(zkeyUrl)
    if (!zkeyResponse.ok) {
      throw new Error(`Failed to download zkey: ${zkeyResponse.status} from ${zkeyUrl}`)
    }
    const zkeyCompressed = await zkeyResponse.arrayBuffer()

    onProgress?.(23, 'Decompressing proving key...')
    zkey = await decompressBrotli(zkeyCompressed)

    // Cache decompressed artifacts for next time
    onProgress?.(25, 'Caching artifacts...')
    await store.store('', wasmPath, new Uint8Array(wasm))
    await store.store('', zkeyPath, new Uint8Array(zkey))
  }

  return { wasm, zkey }
}

/**
 * Generate ZK proof client-side
 */
export async function generateProofClientSide(
  params: GenerateProofParams
): Promise<ProofResult> {
  const {
    privateInputs,
    publicInputs,
    spendingPrivateKey,
    chainId,
    treeNumber,
    outputCount = 1,
    commitmentCiphertext = [],
    isTransact = false,
    adaptContract,
    adaptParams,
    onProgress
  } = params

  // @ts-ignore - snarkjs doesn't have complete type definitions
  const snarkjs = await import('snarkjs')

  // Step 1: Get circuit artifacts (01x01 for 1 output, 01x02 for 2 outputs)
  const { wasm, zkey } = await getCircuitArtifacts(outputCount, onProgress)

  // Step 2: Build boundParams and compute hash
  onProgress?.(30, 'Computing bound parameters...')

  // For partial unshield (01x02), we need commitmentCiphertext for the change note
  // For transact (no unshield), set unshield=0 to signal pure internal transfer
  // The unshield output doesn't need ciphertext (recipient is public address)
  // Only the change note needs to be encrypted for the sender to rediscover it
  const boundParams: BoundParamsV2 = {
    treeNumber,
    minGasPrice: 0,
    unshield: isTransact ? 0 : 1, // 0 = no unshield (transact), 1 = normal unshield
    chainID: ByteUtils.hexlify(chainId, true),
    adaptContract: adaptContract ?? ethers.ZeroAddress,
    adaptParams: adaptParams ?? ethers.ZeroHash,
    commitmentCiphertext
  }

  const abiCoder = ethers.AbiCoder.defaultAbiCoder()
  const hashed = keccak256(
    abiCoder.encode(
      [
        'tuple(uint16 treeNumber, uint48 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams'
      ],
      [boundParams]
    )
  )
  const boundParamsHash = ByteUtils.hexToBigInt(hashed) % BigInt(SNARK_PRIME)
  publicInputs.boundParamsHash = boundParamsHash

  // Step 3: Generate EDDSA signature
  onProgress?.(35, 'Generating signature...')

  const msg = poseidon([
    publicInputs.merkleRoot,
    publicInputs.boundParamsHash,
    ...publicInputs.nullifiers,
    ...publicInputs.commitmentsOut
  ])
  const signature = signEDDSA(spendingPrivateKey, msg)
  const signatureFormatted = [
    signature.R8[0].toString(),
    signature.R8[1].toString(),
    signature.S.toString()
  ]

  // Step 4: Format circuit inputs
  onProgress?.(40, 'Preparing circuit inputs...')

  const bigintArrayToStringArray = (arr: bigint[]): string[] => {
    return arr.map(v => v.toString())
  }

  const circuitInputs = {
    merkleRoot: publicInputs.merkleRoot.toString(),
    boundParamsHash: boundParamsHash.toString(),
    nullifiers: bigintArrayToStringArray(publicInputs.nullifiers),
    commitmentsOut: bigintArrayToStringArray(publicInputs.commitmentsOut),
    token: privateInputs.tokenAddress.toString(),
    publicKey: bigintArrayToStringArray(privateInputs.publicKey),
    signature: signatureFormatted,
    randomIn: bigintArrayToStringArray(privateInputs.randomIn),
    valueIn: bigintArrayToStringArray(privateInputs.valueIn),
    pathElements: privateInputs.pathElements.flat(2).map(e => e.toString()),
    leavesIndices: bigintArrayToStringArray(privateInputs.leavesIndices),
    nullifyingKey: privateInputs.nullifyingKey.toString(),
    npkOut: bigintArrayToStringArray(privateInputs.npkOut),
    valueOut: bigintArrayToStringArray(privateInputs.valueOut)
  }


  // Step 5: Generate proof with snarkjs
  onProgress?.(50, 'Generating zero-knowledge proof (this takes 5-30 seconds)...')

  try {
    const { proof } = await snarkjs.groth16.fullProve(
      circuitInputs,
      new Uint8Array(wasm),
      new Uint8Array(zkey)
    )

    onProgress?.(90, 'Formatting proof...')

    // Convert snarkjs proof format to our Proof format
    // Note: snarkjs returns pi_b elements in reverse order
    const formattedProof: Proof = {
      pi_a: [proof.pi_a[0], proof.pi_a[1]],
      pi_b: [
        [proof.pi_b[0][1], proof.pi_b[0][0]],
        [proof.pi_b[1][1], proof.pi_b[1][0]]
      ],
      pi_c: [proof.pi_c[0], proof.pi_c[1]]
    }

    onProgress?.(95, 'Proof generated!')

    return { proof: formattedProof, publicInputs, boundParams }
  } catch (error) {
    console.error('[Prover] Proof generation failed:', error)
    console.error('[Prover] Circuit inputs at time of failure:', JSON.stringify({
      merkleRoot: circuitInputs.merkleRoot,
      boundParamsHash: circuitInputs.boundParamsHash,
      nullifiers: circuitInputs.nullifiers,
      commitmentsOut: circuitInputs.commitmentsOut,
      token: circuitInputs.token,
      valueIn: circuitInputs.valueIn,
      valueOut: circuitInputs.valueOut
    }, null, 2))
    throw new Error(`Proof generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}
