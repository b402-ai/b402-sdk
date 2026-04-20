/**
 * Client-Side UTXO Fetcher
 *
 * Fetches spendable UTXOs from the indexed backend API.
 * This avoids the slow merkle tree scanning that the SDK does.
 *
 * Supports two types of UTXOs:
 * 1. Shield commitments - from original shield() calls
 * 2. Change notes - from partial unshield TRANSACT events
 */

import type { ShieldCommitment, MerkleProofResponse, OutputCommitment, NullifierUsedData } from './types'
import { fetchCommitmentsByEOA, fetchNullifierDataBatched } from './api'
import { PRIVACY_CONFIG } from './local-config'
// Import from main package where available
import { ShieldNote, ByteUtils, ByteLength } from '@railgun-community/engine'
// Import from subpaths (pnpm.packageExtensions in package.json extends exports)
import { poseidon } from '@railgun-community/engine/dist/utils/poseidon'
import { getSharedSymmetricKey } from '@railgun-community/engine/dist/utils/keys-utils'
import { decryptChangeNote } from './note-encryption'
import { getStoredChangeNotes, removeChangeNote } from './change-note-store'
// Import shield cache for UserOp shields (backend indexes by bundler, not user EOA)
import { getCachedShields, type CachedShield } from './shield-cache'

export interface DecryptedNote {
  value: bigint
  random: bigint
  notePublicKey: bigint
  tokenAddress: string
}

export interface SpendableUTXO {
  commitment: ShieldCommitment
  merkleProof: MerkleProofResponse
  note: DecryptedNote
  nullifier: string
  tree: number
  position: number
}

/**
 * Convert a CachedShield (from local storage) to ShieldCommitment format
 * This allows us to process locally cached shields the same way as API shields
 */
function cachedShieldToCommitment(cached: CachedShield): ShieldCommitment {
  return {
    commitmentHash: cached.commitmentHash,
    treeNumber: cached.treeNumber,
    position: cached.position,
    tokenAddress: cached.tokenAddress,
    tokenType: 0, // ERC20
    tokenSubID: '0',
    amount: cached.amount,
    fee: '0',
    npk: cached.npk,
    encryptedBundle0: cached.encryptedBundle0,
    encryptedBundle1: cached.encryptedBundle1,
    encryptedBundle2: cached.encryptedBundle2,
    shieldKey: cached.shieldKey
  }
}

/**
 * Compute nullifier for a UTXO
 * nullifier = poseidon(nullifyingKey, position)
 */
export function computeNullifier(
  nullifyingKey: bigint,
  position: number
): string {
  const nullifier = poseidon([nullifyingKey, BigInt(position)])
  // Ensure 0x prefix and 64 hex chars (32 bytes)
  return `0x${nullifier.toString(16).padStart(64, '0')}`
}

/**
 * Decrypt a shield commitment to extract note data
 */
async function decryptShieldCommitment(
  commitment: ShieldCommitment,
  viewingPrivateKey: Uint8Array,
  masterPublicKey: bigint,
  debug = false
): Promise<DecryptedNote | null> {
  try {
    // Get shared key from shield key
    const shieldKeyBuffer = Buffer.from(commitment.shieldKey.replace('0x', ''), 'hex')
    const sharedKey = await getSharedSymmetricKey(viewingPrivateKey, shieldKeyBuffer)
    if (!sharedKey) {
      if (debug) console.log('[decrypt] Failed to get shared key for commitment', commitment.commitmentHash.slice(0, 10))
      return null
    }

    // Decrypt the random value
    const encryptedBundle: [string, string, string] = [
      commitment.encryptedBundle0,
      commitment.encryptedBundle1,
      commitment.encryptedBundle2
    ]
    const random = ShieldNote.decryptRandom(encryptedBundle, sharedKey)

    // Helper to convert random to bigint (handles string without 0x prefix)
    const toBigInt = (val: bigint | string): bigint => {
      if (typeof val === 'bigint') return val
      // Add 0x prefix if it's a hex string without it
      const hexStr = val.startsWith('0x') ? val : `0x${val}`
      return BigInt(hexStr)
    }

    const randomBigInt = toBigInt(random)

    // Compute NPK and verify
    const computedNPK = ShieldNote.getNotePublicKey(masterPublicKey, random)
    const computedNPKBigInt = toBigInt(computedNPK)
    const expectedNPK = toBigInt(commitment.npk)


    if (computedNPKBigInt !== expectedNPK) {
      return null
    }

    return {
      value: BigInt(commitment.amount),
      random: randomBigInt,
      notePublicKey: computedNPKBigInt,
      tokenAddress: commitment.tokenAddress
    }
  } catch {
    // Decryption fails for commitments that don't belong to this wallet
    // This is expected behavior - just skip silently
    return null
  }
}

/**
 * @deprecated Use discoverChangeNotesFromCache instead
 *
 * Discover change notes from TRANSACT events (OLD METHOD - UNRELIABLE)
 *
 * This method tries to decrypt ALL TRANSACT events, but most of them are
 * from OTHER users' transactions, causing decryption failures.
 *
 * When a partial unshield occurs, the change goes into a new encrypted note.
 * This function discovers those notes by:
 * 1. Looking at TRANSACT events from the nullifier history
 * 2. Trying to decrypt the outputCommitments
 * 3. Returning successfully decrypted notes as potential UTXOs
 */
async function discoverChangeNotes(
  transactEvents: NullifierUsedData[],
  viewingPrivateKey: Uint8Array,
  masterPublicKey: bigint,
  nullifyingKey: bigint,
  tokenAddress?: string
): Promise<Array<{
  commitment: ShieldCommitment
  note: DecryptedNote
  nullifier: string
  position: number
  tree: number
}>> {
  const discoveredNotes: Array<{
    commitment: ShieldCommitment
    note: DecryptedNote
    nullifier: string
    position: number
    tree: number
  }> = []

  for (const event of transactEvents) {
    if (event.type !== 'TRANSACT' || !event.outputCommitments) {
      continue
    }

    for (const output of event.outputCommitments) {
      try {
        const ciphertext = output.ciphertext
        if (!ciphertext) {
          continue
        }

        // Skip outputs with empty blinded keys (e.g., unshield outputs which don't have ciphertext)
        // Only change notes have valid ciphertext with blinded keys
        const hasValidBlindedKeys = ciphertext.blindedSenderViewingKey &&
          ciphertext.blindedSenderViewingKey !== '' &&
          ciphertext.blindedSenderViewingKey !== '0x' &&
          ciphertext.blindedSenderViewingKey !== '0x0000000000000000000000000000000000000000000000000000000000000000'

        if (!hasValidBlindedKeys) {
          continue
        }

        // Try to decrypt the change note - pass both blinded keys like Railgun engine does
        // For receiving: use blindedSenderViewingKey
        // For sent notes (our own change notes): use blindedReceiverViewingKey
        const decrypted = await decryptChangeNote(
          [ciphertext.ciphertext0, ciphertext.ciphertext1, ciphertext.ciphertext2, ciphertext.ciphertext3],
          ciphertext.blindedSenderViewingKey,
          viewingPrivateKey,
          ciphertext.blindedReceiverViewingKey // Try both keys
        )

        if (!decrypted) {
          continue
        }

        // Verify the note belongs to us by checking the MPK matches
        // The decrypted.masterPublicKey is the encoded MPK from encryption
        // We need to verify it matches our MPK
        const computedNpk = poseidon([masterPublicKey, decrypted.random])

        // Get token address from token hash
        // For ERC20, tokenHash is just the address padded to 32 bytes
        const tokenAddressFromHash = '0x' + decrypted.tokenHash.slice(-40)

        // Filter by token if specified
        if (tokenAddress && tokenAddressFromHash.toLowerCase() !== tokenAddress.toLowerCase()) {
          continue
        }

        const position = parseInt(output.position, 10)
        const tree = 0 // Change notes go to tree 0 (current tree)
        const nullifier = computeNullifier(nullifyingKey, position)

        // Create a ShieldCommitment-like object for compatibility
        const fakeShieldCommitment: ShieldCommitment = {
          commitmentHash: output.commitmentHash,
          treeNumber: tree.toString(),
          position: output.position,
          tokenAddress: tokenAddressFromHash,
          tokenType: 0,
          tokenSubID: '0',
          amount: decrypted.value.toString(),
          fee: '0',
          npk: `0x${computedNpk.toString(16).padStart(64, '0')}`,
          encryptedBundle0: ciphertext.ciphertext0,
          encryptedBundle1: ciphertext.ciphertext1,
          encryptedBundle2: ciphertext.ciphertext2,
          shieldKey: ciphertext.blindedReceiverViewingKey // Not exactly the same but for compatibility
        }

        discoveredNotes.push({
          commitment: fakeShieldCommitment,
          note: {
            value: decrypted.value,
            random: decrypted.random,
            notePublicKey: computedNpk,
            tokenAddress: tokenAddressFromHash
          },
          nullifier,
          position,
          tree
        })
      } catch {
        // Failed to decrypt - note doesn't belong to us, skip
        continue
      }
    }
  }

  return discoveredNotes
}

/**
 * Discover change notes from local cache
 *
 * Fully frontend - no backend calls. Position is extracted from tx receipt.
 *
 * Flow:
 * 1. Load cached change notes from localStorage
 * 2. Use stored position (from tx receipt) - skip notes without position
 * 3. Compute nullifier and return as spendable UTXOs
 */
function discoverChangeNotesFromCache(
  signerAddress: string,
  nullifyingKey: bigint,
  tokenAddress?: string
): Array<{
  commitment: ShieldCommitment
  note: DecryptedNote
  nullifier: string
  position: number
  tree: number
}> {
  const storedNotes = getStoredChangeNotes(signerAddress)
  const results: Array<{
    commitment: ShieldCommitment
    note: DecryptedNote
    nullifier: string
    position: number
    tree: number
  }> = []

  for (const stored of storedNotes) {
    // Filter by token if specified
    if (tokenAddress && stored.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
      continue
    }

    // Skip notes without position - they were created before the fix
    // User needs to do a new partial unshield to get proper position tracking
    if (!stored.position || !stored.treeNumber) {
      continue
    }

    const position = parseInt(stored.position, 10)
    const tree = parseInt(stored.treeNumber, 10)

    // Compute nullifier using the position
    const nullifier = computeNullifier(nullifyingKey, position)

    // Create a ShieldCommitment-like object for compatibility
    const fakeShieldCommitment: ShieldCommitment = {
      commitmentHash: stored.commitmentHash,
      treeNumber: tree.toString(),
      position: position.toString(),
      tokenAddress: stored.tokenAddress,
      tokenType: 0,
      tokenSubID: '0',
      amount: stored.value,
      fee: '0',
      npk: `0x${stored.npk}`,
      encryptedBundle0: '0x',
      encryptedBundle1: '0x',
      encryptedBundle2: '0x',
      shieldKey: '0x'
    }

    results.push({
      commitment: fakeShieldCommitment,
      note: {
        value: BigInt(stored.value),
        random: BigInt(stored.random),
        notePublicKey: BigInt(stored.npk),
        tokenAddress: stored.tokenAddress
      },
      nullifier,
      position,
      tree
    })
  }

  return results
}

/**
 * Fetch spendable UTXOs for a user
 *
 * This fetches both:
 * 1. Original shield commitments
 * 2. Change notes from partial unshield TRANSACT events
 *
 * @param signerAddress - EOA address that signed
 * @param viewingPrivateKey - Derived viewing private key
 * @param masterPublicKey - Derived master public key
 * @param nullifyingKey - Derived nullifying key
 * @param tokenAddress - Optional filter by token
 */
export async function fetchSpendableUTXOs(
  signerAddress: string,
  viewingPrivateKey: Uint8Array,
  masterPublicKey: bigint,
  nullifyingKey: bigint,
  tokenAddress?: string,
  chainId?: number
): Promise<SpendableUTXO[]> {
  // Use chain-specific backend API URL when chainId is provided (critical for multi-chain)
  const { getBackendApiUrl } = await import('../../config/chains')
  const apiUrl = chainId ? getBackendApiUrl(chainId) : PRIVACY_CONFIG.BACKEND_API_URL

  // Step 1: Fetch all shield commitments for this EOA from backend API
  const { shields: apiShields } = await fetchCommitmentsByEOA(apiUrl, signerAddress, undefined, chainId)

  // Step 1b: Get shields from local cache (critical for UserOp shields)
  const cachedShields = getCachedShields(signerAddress)

  // Merge API shields with cached shields, deduplicating by position+treeNumber
  const seenPositions = new Set<string>()
  const shields: ShieldCommitment[] = []

  for (const shield of apiShields) {
    const key = `${shield.treeNumber}-${shield.position}`
    if (!seenPositions.has(key)) {
      seenPositions.add(key)
      shields.push(shield)
    }
  }

  for (const cached of cachedShields) {
    const key = `${cached.treeNumber}-${cached.position}`
    if (!seenPositions.has(key)) {
      seenPositions.add(key)
      shields.push(cachedShieldToCommitment(cached))
    }
  }

  // Step 2: Decrypt shield commitments and compute nullifiers
  const decryptedCommitments: Array<{
    commitment: ShieldCommitment
    note: DecryptedNote
    nullifier: string
    position: number
    tree: number
  }> = []

  for (const shield of shields) {
    // Filter by token if specified
    if (tokenAddress && shield.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
      continue
    }

    const note = await decryptShieldCommitment(shield, viewingPrivateKey, masterPublicKey, false)
    if (!note) {
      continue
    }

    const position = parseInt(shield.position, 10)
    const tree = parseInt(shield.treeNumber, 10)
    const nullifier = computeNullifier(nullifyingKey, position)

    decryptedCommitments.push({
      commitment: shield,
      note,
      nullifier,
      position,
      tree
    })
  }

  // Step 3: Check which nullifiers are used (spent)
  // CRITICAL: Use usedSet (not unusedSet) to determine spendability
  // Backend may DROP nullifiers it doesn't recognize (e.g., UserOp shields not yet indexed)
  // Dropped nullifiers are absent from BOTH used and unused arrays
  // A shield is only spent if its nullifier is EXPLICITLY in the used set
  const nullifiers = decryptedCommitments.map(c => c.nullifier)
  const spendableSet = new Set<string>()
  let nullifierStatus: Awaited<ReturnType<typeof fetchNullifierDataBatched>> | null = null

  if (nullifiers.length > 0) {
    nullifierStatus = await fetchNullifierDataBatched(apiUrl, nullifiers, chainId)
    const usedSet = new Set(nullifierStatus.used.map(n => n.nullifier.toLowerCase()))
    for (const c of decryptedCommitments) {
      if (!usedSet.has(c.nullifier.toLowerCase())) {
        spendableSet.add(c.nullifier.toLowerCase())
      }
    }
  }

  // Step 3b: Discover change notes from TRANSACT events (cross-device recovery)
  if (nullifierStatus) {
    const transactEvents = nullifierStatus.used.filter(n => n.type === 'TRANSACT')
    if (transactEvents.length > 0) {
      const backendChangeNotes = await discoverChangeNotes(
        transactEvents, viewingPrivateKey, masterPublicKey, nullifyingKey, tokenAddress
      )
      if (backendChangeNotes.length > 0) {
        const changeNullifiers = backendChangeNotes.map(c => c.nullifier)
        const changeStatus = await fetchNullifierDataBatched(apiUrl, changeNullifiers, chainId)
        const changeUsedSet = new Set(changeStatus.used.map(n => n.nullifier.toLowerCase()))
        for (const cn of backendChangeNotes) {
          if (!changeUsedSet.has(cn.nullifier.toLowerCase())) {
            decryptedCommitments.push(cn)
            spendableSet.add(cn.nullifier.toLowerCase())
          }
        }
      }
    }
  }

  // Step 4: Discover change notes from LOCAL CACHE (preferred method)
  const cachedChangeNotes = discoverChangeNotesFromCache(
    signerAddress,
    nullifyingKey,
    tokenAddress
  )

  // Step 5: Check which change note nullifiers are still spendable
  if (cachedChangeNotes.length > 0) {
    const changeNullifiers = cachedChangeNotes.map(c => c.nullifier)
    const changeNullifierStatus = await fetchNullifierDataBatched(apiUrl, changeNullifiers, chainId)
    const changeUsedSet = new Set(changeNullifierStatus.used.map(n => n.nullifier.toLowerCase()))

    for (const changeNote of cachedChangeNotes) {
      if (!changeUsedSet.has(changeNote.nullifier.toLowerCase())) {
        decryptedCommitments.push(changeNote)
        spendableSet.add(changeNote.nullifier.toLowerCase())
      } else {
        removeChangeNote(signerAddress, changeNote.commitment.commitmentHash)
      }
    }
  }

  // Step 7: Filter to only spendable UTXOs (both shields and change notes)
  const spendableCommitments = decryptedCommitments.filter(
    c => spendableSet.has(c.nullifier.toLowerCase())
  )

  if (spendableCommitments.length === 0) {
    return []
  }

  // Step 8: Fetch merkle proofs for spendable UTXOs (with rate limiting)
  // Some proofs may fail (database inconsistency) — skip those UTXOs
  const { fetchMerkleProofsBatch } = await import('./api')
  const merkleProofs = await fetchMerkleProofsBatch(
    apiUrl,
    spendableCommitments.map(c => ({
      commitmentHash: c.commitment.commitmentHash,
      treeNumber: c.commitment.treeNumber,
      position: c.commitment.position
    })),
    chainId ? { chainId } : undefined
  )

  const spendableUTXOs: SpendableUTXO[] = []
  for (let index = 0; index < spendableCommitments.length; index++) {
    const proof = merkleProofs[index]
    if (!proof) {
      continue
    }
    const c = spendableCommitments[index]
    spendableUTXOs.push({
      commitment: c.commitment,
      merkleProof: proof,
      note: c.note,
      nullifier: c.nullifier,
      tree: c.tree,
      position: c.position
    })
  }

  return spendableUTXOs
}

/**
 * Lightweight UTXO check - only fetches commitments and nullifier status
 * Does NOT fetch merkle proofs (avoids rate limiting during polling)
 *
 * Use this for polling/checking, then call fetchSpendableUTXOs when ready to process
 *
 * IMPORTANT: This function now discovers BOTH original shields AND change notes from
 * partial unshields. Change notes are discovered by checking nullifier status of
 * original shields and looking at TRANSACT events that created new outputs.
 */
export async function fetchSpendableUTXOsLightweight(
  signerAddress: string,
  viewingPrivateKey: Uint8Array,
  masterPublicKey: bigint,
  nullifyingKey: bigint,
  tokenAddress?: string,
  chainId?: number
): Promise<Array<{
  commitment: ShieldCommitment
  note: DecryptedNote
  nullifier: string
  position: number
  tree: number
}>> {
  // Use chain-specific backend API URL when chainId is provided (critical for multi-chain)
  const { getBackendApiUrl } = await import('../../config/chains')
  const apiUrl = chainId ? getBackendApiUrl(chainId) : PRIVACY_CONFIG.BACKEND_API_URL

  // Step 1: Fetch all shield commitments for this EOA from backend API
  const { shields: apiShields } = await fetchCommitmentsByEOA(apiUrl, signerAddress, undefined, chainId)

  // Step 1b: Get shields from local cache (critical for UserOp shields)
  // UserOp shields are indexed by bundler address on backend, not user EOA
  // So we need to check local cache first
  const cachedShields = getCachedShields(signerAddress)

  // Merge API shields with cached shields, deduplicating by position+treeNumber
  const seenPositions = new Set<string>()
  const shields: ShieldCommitment[] = []

  // Add API shields first
  for (const shield of apiShields) {
    const key = `${shield.treeNumber}-${shield.position}`
    if (!seenPositions.has(key)) {
      seenPositions.add(key)
      shields.push(shield)
    }
  }

  // Add cached shields that aren't already in API results
  for (const cached of cachedShields) {
    const key = `${cached.treeNumber}-${cached.position}`
    if (!seenPositions.has(key)) {
      seenPositions.add(key)
      shields.push(cachedShieldToCommitment(cached))
    }
  }

  // Collect all spendable UTXOs (both shields and change notes)
  const allSpendable: Array<{
    commitment: ShieldCommitment
    note: DecryptedNote
    nullifier: string
    position: number
    tree: number
  }> = []

  // Step 2: Decrypt shield commitments and compute nullifiers
  const decryptedShields: Array<{
    commitment: ShieldCommitment
    note: DecryptedNote
    nullifier: string
    position: number
    tree: number
  }> = []

  for (const shield of shields) {
    // Filter by token if specified
    if (tokenAddress && shield.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
      continue
    }

    const note = await decryptShieldCommitment(shield, viewingPrivateKey, masterPublicKey, false)
    if (!note) {
      continue
    }

    const position = parseInt(shield.position, 10)
    const tree = parseInt(shield.treeNumber, 10)
    const nullifier = computeNullifier(nullifyingKey, position)

    decryptedShields.push({
      commitment: shield,
      note,
      nullifier,
      position,
      tree
    })
  }

  // Step 3: Check nullifier status for shields (even if empty, we need to check for change notes)
  // The nullifier API call also returns TRANSACT events that have outputCommitments (change notes)
  let nullifierStatus: Awaited<ReturnType<typeof fetchNullifierDataBatched>> | null = null

  if (decryptedShields.length > 0) {
    const shieldNullifiers = decryptedShields.map(c => c.nullifier)
    nullifierStatus = await fetchNullifierDataBatched(apiUrl, shieldNullifiers, chainId)

    // CRITICAL: Use usedSet (not unusedSet) to determine spendability
    // Backend may DROP nullifiers it doesn't recognize (e.g., UserOp shields not yet indexed)
    // Dropped nullifiers would be absent from BOTH used and unused arrays
    // If we checked unusedSet, dropped nullifiers would be wrongly treated as "spent"
    // Instead: a shield is only spent if its nullifier is EXPLICITLY in the used set
    const usedSet = new Set(nullifierStatus.used.map(n => n.nullifier.toLowerCase()))

    for (const shield of decryptedShields) {
      if (!usedSet.has(shield.nullifier.toLowerCase())) {
        // Not explicitly used → spendable (covers both "unused" and "dropped/unknown")
        allSpendable.push(shield)
      }
    }

  }

  // Step 3b: Discover change notes from TRANSACT events (cross-device recovery)
  if (nullifierStatus) {
    const transactEvents = nullifierStatus.used.filter(n => n.type === 'TRANSACT')
    if (transactEvents.length > 0) {
      const backendChangeNotes = await discoverChangeNotes(
        transactEvents, viewingPrivateKey, masterPublicKey, nullifyingKey, tokenAddress
      )
      if (backendChangeNotes.length > 0) {
        // Check which change notes are still spendable
        const changeNullifiers = backendChangeNotes.map(c => c.nullifier)
        const changeStatus = await fetchNullifierDataBatched(apiUrl, changeNullifiers, chainId)
        const changeUsedSet = new Set(changeStatus.used.map(n => n.nullifier.toLowerCase()))
        for (const cn of backendChangeNotes) {
          if (!changeUsedSet.has(cn.nullifier.toLowerCase())) {
            allSpendable.push(cn)
          }
        }
      }
    }
  }

  // Step 4: Discover change notes from LOCAL CACHE
  const cachedChangeNotes = discoverChangeNotesFromCache(
    signerAddress,
    nullifyingKey,
    tokenAddress
  )

  // Step 5: Check which change note nullifiers are unused (spendable)
  if (cachedChangeNotes.length > 0) {
    const changeNullifiers = cachedChangeNotes.map(c => c.nullifier)
    const changeNullifierStatus = await fetchNullifierDataBatched(apiUrl, changeNullifiers, chainId)
    const changeUnusedSet = new Set(changeNullifierStatus.unused.map(n => n.toLowerCase()))

    for (const changeNote of cachedChangeNotes) {
      if (changeUnusedSet.has(changeNote.nullifier.toLowerCase())) {
        allSpendable.push(changeNote)
      } else {
        // Change note has been spent - remove from cache
        removeChangeNote(signerAddress, changeNote.commitment.commitmentHash)
      }
    }
  }

  return allSpendable
}

/**
 * Upgrade lightweight UTXOs to full SpendableUTXOs by fetching merkle proofs
 */
export async function upgradeToFullUTXOs(
  lightweightUtxos: Array<{
    commitment: ShieldCommitment
    note: DecryptedNote
    nullifier: string
    position: number
    tree: number
  }>,
  chainId?: number
): Promise<SpendableUTXO[]> {
  if (lightweightUtxos.length === 0) {
    return []
  }

  const apiUrl = PRIVACY_CONFIG.BACKEND_API_URL
  const { fetchMerkleProofsBatch } = await import('./api')

  const merkleProofs = await fetchMerkleProofsBatch(
    apiUrl,
    lightweightUtxos.map(c => ({
      commitmentHash: c.commitment.commitmentHash,
      treeNumber: c.commitment.treeNumber,
      position: c.commitment.position
    })),
    chainId ? { chainId } : undefined
  )

  return lightweightUtxos.map((c, index) => ({
    commitment: c.commitment,
    merkleProof: merkleProofs[index]!,
    note: c.note,
    nullifier: c.nullifier,
    tree: c.tree,
    position: c.position
  }))
}

/**
 * Get total spendable balance for a token
 */
export function getSpendableBalance(utxos: SpendableUTXO[], tokenAddress: string): bigint {
  return utxos
    .filter(u => u.note.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
    .reduce((sum, u) => sum + u.note.value, BigInt(0))
}

/**
 * Select UTXOs to cover a target amount
 * Uses simple greedy algorithm - largest first
 */
export function selectUTXOsForAmount(
  utxos: SpendableUTXO[],
  targetAmount: bigint,
  tokenAddress: string
): SpendableUTXO[] {
  const tokenUTXOs = utxos
    .filter(u => u.note.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
    .sort((a, b) => Number(b.note.value - a.note.value)) // Largest first

  const selected: SpendableUTXO[] = []
  let total = BigInt(0)

  for (const utxo of tokenUTXOs) {
    if (total >= targetAmount) break
    selected.push(utxo)
    total += utxo.note.value
  }

  if (total < targetAmount) {
    throw new Error(`Insufficient balance. Need ${targetAmount}, have ${total}`)
  }

  return selected
}
