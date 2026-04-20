export interface PrivacyBalance {
  eoa: string;
  railgunAddress: string;
  tokenBalances: Array<{
    tokenAddress: string;
    balance: bigint;
    commitmentCount: number;
  }>;
}

export interface IncognitoWallet {
  eoa: string;
  smartWallet: string;
}

export interface ShieldCommitment {
  commitmentHash: string
  treeNumber: string
  position: string
  tokenAddress: string
  tokenType: number
  tokenSubID: string
  amount: string
  fee: string
  npk: string
  encryptedBundle0: string
  encryptedBundle1: string
  encryptedBundle2: string
  shieldKey: string
}

export interface OutputCommitment {
  commitmentHash: string
  position: string
  ciphertext: {
    ciphertext0: string
    ciphertext1: string
    ciphertext2: string
    ciphertext3: string
    blindedSenderViewingKey: string
    blindedReceiverViewingKey: string
    annotationData: string
    memo: string
  }
}

export interface UnshieldData {
  recipientAddress: string
  tokenAddress: string
  tokenType: number
  tokenSubID: string
  amount: string
  fee: string
}

export interface NullifierUsedData {
  nullifier: string
  transactionHash: string
  blockNumber: string
  blockTime: string
  type: 'TRANSACT' | 'UNSHIELD'
  outputCommitments?: OutputCommitment[]
  unshieldData?: UnshieldData
}

export interface NullifierScanResponse {
  used: NullifierUsedData[]
  unused: string[]
}

export interface MerkleProofResponse {
  proof: string[]
  root: string
  leafIndex: string
  pathIndices: number[]
  treeDepth: number
}

export interface TokenBalance {
  tokenAddress: string
  balance: bigint
  commitmentCount: number
  symbol?: string
  decimals?: number
}

export interface PrivacyBalanceResult {
  eoa: string
  railgunAddress: string
  totalCommitments: number
  spendableCommitments: number
  usedCommitments: number
  tokenBalances: TokenBalance[]
}

// SpendableUTXO is exported from utxo-fetcher.ts - removed duplicate here

