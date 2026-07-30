# Gavel

![Gavel](.github/banner.jpg)

![CI](https://github.com/MrShiroLu/gavel/actions/workflows/ci.yml/badge.svg)

**Live demo:** [gavel-sand.vercel.app](https://gavel-sand.vercel.app)
Still needs a local proof server (`docker compose up -d proof-server`) and Lace on Preprod, even though the frontend is hosted.

Sealed-bid auctions on the Midnight Network. Bids are private commitments.
Losing bid amounts are never published, not at close, not to the platform,
not to anyone. The winner and the clearing price are settled on-chain and
can be verified.

The project has two parts: a Compact contract with TypeScript devnet and CLI
tooling at the repo root, and a React frontend in `frontend/` that talks to
the contract through the Lace wallet. Each auction is its own contract
instance deployed by the seller; there is no on-chain registry. Circuits:
`openBidding`, `submitBid`, `closeBidding`, `cancelAuction`, `settleBid`,
`finalizeSettlement`.

## Privacy model

- **Public:** that an auction exists, its metadata and deadlines, the number
  of sealed bids, the winner, and the clearing price.
- **Private:** losing bid amounts and the identity of losing bidders.
- **Known limitation:** without multi-party computation, no settlement
  mechanism can compare private bids with zero leakage. Gavel's settlement
  (a rolling maximum over a settlement window) leaks at most the running
  maximum during that window. Bids that never exceed it stay hidden. This
  is still better than commit-reveal, where every bid becomes public.

## Requirements

- Node 22
- Docker with Compose v2
- The Compact compiler (`compact update <version>` and `compact use <version>`
  to match the version pinned in `.compact-version`)

## Quick start: contract and devnet

```bash
npm install
npm run setup           # start local devnet, compile, deploy
npm run test:e2e        # smoke check against the devnet
npm run test:auction    # compile + simulator lifecycle check
```

`npm run setup` starts a local Midnight devnet (node, indexer, proof server)
via Docker Compose, compiles the scaffold contract, and deploys it using the
devnet genesis-seed wallet. Tear the devnet down with `docker compose down -v`.

**Local devnet only:** the deploy script uses the well-known genesis seed so
pre-minted funds are immediately available. Never use this seed on Preprod,
mainnet, or any environment that handles real value.

## Quick start: frontend

The frontend requires a running local proof server and the Lace wallet
extension connected to Preprod.

```bash
npm run compile:auction             # once, at the repo root
docker compose up -d proof-server
cd frontend
npm install
npm run dev
```

`npm run dev` and `npm run build` copy the compiled contract's ZK artifacts
into `public/zk/` before starting. `VITE_PROOF_SERVER_URL` overrides the
default proof server URL (`http://127.0.0.1:6300`).

## Networks

| Network      | Purpose                                          |
| ------------ | ------------------------------------------------- |
| `undeployed` | Local devnet from `docker-compose.yml`. Default. |
| `preview`    | Public preview testnet with faucet.              |
| `preprod`    | Public preprod testnet with faucet.              |

The root scripts remember the last network used; switch with
`npm run network <name>` or per-run with `--network <name>`. The frontend is
fixed to Preprod. On first use of a public network, `setup` generates a
seed, prints the wallet address and faucet URL, and waits for funding.
Seeds and deploy addresses persist in `.midnight-state.json` (gitignored).
Back up any seed you fund.

Environment overrides (apply to the active network): `MIDNIGHT_WALLET_SEED`,
`MIDNIGHT_INDEXER_URL`, `MIDNIGHT_INDEXER_WS_URL`, `MIDNIGHT_NODE_URL`,
`MIDNIGHT_FAUCET_URL`, `MIDNIGHT_PROOF_SERVER_URL`,
`MIDNIGHT_FAUCET_TIMEOUT_MS`. All networks default to the local proof server,
which keeps witness data on your machine.

## Scripts

Root:

| Script                         | Description                              |
| ------------------------------- | ----------------------------------------- |
| `npm run setup`                | Start devnet, compile, deploy.           |
| `npm run compile:auction`      | Compile the auction contract.            |
| `npm run cli`                  | Interactive CLI against the deployed contract. |
| `npm run test:auction`         | Simulator lifecycle check.               |
| `npm run test:auction:onchain` | Full lifecycle against the local devnet. |
| `npm run test:auction:preprod` | Full lifecycle against Preprod.          |
| `npm run clean`                | Remove generated artifacts and state.    |

The Preprod check syncs three wallets. A cold from-genesis sync is very
memory-hungry, so warm each role's cache first with
`npm run test:auction:preprod:warm -- <seller|alice|bob>`, then run the check.

Frontend:

| Script          | Description                                    |
| --------------- | ----------------------------------------------- |
| `npm run dev`   | Copy ZK artifacts, start the Vite dev server. |
| `npm run build` | Type-check and production build.               |
| `npm run lint`  | Lint with oxlint.                               |

## CI

Every push runs the auction simulator check plus frontend lint and build. A
nightly job also spins up the local devnet and runs the full on-chain
auction lifecycle with real proofs. That run waits out the real auction
windows, so it stays off the push path.
