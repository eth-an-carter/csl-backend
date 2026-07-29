<div align="center">
  <img src="https://raw.githubusercontent.com/CSLdotFun/.github/main/profile/csl-logo.png" width="90" alt="CSL"/>

  # csl-backend

  **Price engine powering the CSL perpetuals terminal**

  ![Node](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
  ![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
  ![Deploy](https://img.shields.io/badge/deploy-Railway-0B0D0E?logo=railway&logoColor=white)
  ![Feed](https://img.shields.io/badge/feed-Skinport%20%2B%20Steam-3b82f6)
</div>

Live CS2 skin market data for [csl.fun](https://csl.fun): curated markets, real-time prices, OHLC candles, funding rates and a Server-Sent-Events stream.

## Endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/health` | status, active price source |
| GET | `/api/markets` | all markets - price, 24h change, funding |
| GET | `/api/markets/:key` | single market |
| GET | `/api/candles/:key` | live OHLC series (1m base) |
| GET | `/api/history/:key` | full daily history (real Steam Market data) |
| GET | `/api/inventory/:steamid` | public CS2 inventory, CSL-tradable items flagged |
| GET | `/api/stream` | SSE - snapshot + live price ticks |

## Price sources

→ **Skinport** - live lowest-listing prices, free public API, no key  
→ **Steam Market** - full daily price history back to each skin's release  
→ **lis-skins** - optional live source (API key required)  
→ `SOURCE=mock` - deterministic simulated feed for local dev

## Run

```bash
npm install
npm start                 # mock feed
SOURCE=skinport npm start # live prices
```

All configuration via env - see [`.env.example`](.env.example).

- [csl.fun](https://csl.fun) · [docs.csl.fun](https://docs.csl.fun) · [@csldotfun](https://x.com/csldotfun)
