# b402-mcp

Model Context Protocol server for b402 payments and private DeFi.

Works with Claude Desktop, Cursor, Copilot, and other MCP-compatible clients.

## 5-line quickstart

```bash
export WORKER_PRIVATE_KEY=0xYOUR_BASE_KEY
export SEQUENCER_URL=https://your-sequencer-url
npx -y b402-mcp@0.4.0 --help
claude mcp add b402 --scope user -e WORKER_PRIVATE_KEY=$WORKER_PRIVATE_KEY -e SEQUENCER_URL=$SEQUENCER_URL -- npx -y b402-mcp@0.4.0
# then ask Claude: "run b402_balance"
```

## Claude Desktop / MCP config snippet

```json
{
  "mcpServers": {
    "b402": {
      "command": "npx",
      "args": ["-y", "b402-mcp@0.4.0"],
      "env": {
        "WORKER_PRIVATE_KEY": "0x...",
        "SEQUENCER_URL": "https://your-sequencer-url"
      }
    }
  }
}
```

## Payment tools

| Tool | Description |
|------|-------------|
| `b402_pay` | Gasless b402 sequencer payment |
| `b402_balance` | Sequencer credit or wallet/pool balance |
| `b402_create_invoice` | Creates invoice payload + `b402://pay` URL |
| `pay_via_b402` | Standard HTTP 402 verify+settle flow with payment signature retry |

## Private DeFi tools

| Tool | Description |
|------|-------------|
| `shield_usdc` | Move USDC into the Railgun privacy pool |
| `check_pool_balance` | Show wallet + shielded balances and positions |
| `get_swap_quote` | Read-only DEX quote across Base liquidity |
| `private_swap` | Swap in privacy pool with ZK proof |
| `lend_privately` | Lend from pool into Morpho vault |
| `redeem_privately` | Redeem from Morpho vault back to pool |
| `cross_chain_privately` | Private cross-chain transfer or bridge+swap via LI.FI (Base → Arbitrum, etc.) |
| `run_strategy` | Multi-step private strategy (swap + lend + reserve) |

## Copy-paste E2E prompts

**Payment flow:**
```text
1) Run b402_balance with my agentId.
2) Create an invoice for 0.05 USDC with memo "demo call".
3) Run pay_via_b402 on my paid API URL.
4) Run b402_balance again and summarize the delta.
```

**Private cross-chain flow:**
```text
1) Check my privacy pool balance.
2) Privately send 1 USDC from my pool to 0xRECIPIENT on Arbitrum.
3) Now do a private cross-chain swap — 1 USDC from my pool, convert to ARB on Arbitrum, same recipient.
4) Summarize what just happened — what's visible on-chain, what's hidden.
```

Claude will call `cross_chain_privately` — source TX lands on Base via RelayAdapt, destination fill appears on Arbitrum within 15-60s. No on-chain link between source and destination.

## Network notes

- `pay_via_b402` parses both Base and BNB x402 payment requirements.
- Automatic funding (`fundIncognito`) currently uses Base USDC only.
- Base private DeFi tools (`shield_usdc`, `private_swap`, `lend_privately`, etc.) remain Base-focused.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKER_PRIVATE_KEY` | Yes | Base wallet private key used by b402 |
| `SEQUENCER_URL` | For `b402_pay` / credit tools | b402 sequencer endpoint |
| `BASE_RPC_URL` | No | Custom Base RPC URL |
| `BNB_RPC_URL` | No | Optional RPC used when x402 requirement is BNB |
| `FACILITATOR_URL` | No | Custom b402 facilitator URL |

## Links

- SDK: [@b402ai/sdk](https://www.npmjs.com/package/@b402ai/sdk)
- Package: [b402-mcp](https://www.npmjs.com/package/b402-mcp)
- GitHub: [b402ai/b402-sdk](https://github.com/b402ai/b402-sdk)
