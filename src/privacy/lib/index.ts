// SDK privacy library exports
export * from './shield';
export * from './unshield';
export * from './types';
export * from './railgun';
export * from './api';
export * from './tokens';
export * from './artifact-store';
export * from './key-derivation';
export * from './utxo-fetcher';
export * from './proof-inputs';
export * from './prover';
export * from './transaction-formatter';
export * from './note-encryption';

export {
  shieldTokens,
  type ShieldOptions,
  type ShieldResult,
} from './shield';

export {
  unshieldTokens,
  partialUnshieldTokens,
  type UnshieldOptions,
  type UnshieldResult,
  type PartialUnshieldOptions,
  type PartialUnshieldResult,
} from './unshield';

export {
  createIndexedDBArtifactStore,
  clearArtifactCache,
  areArtifactsCached,
} from './artifact-store';

export {
  deriveMnemonicFromEOA,
  getShieldPrivateKey,
} from './railgun';
