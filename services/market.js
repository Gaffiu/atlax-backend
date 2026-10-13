// ============================================================
// services/market.js
// - getCryptoPrice: CoinGecko (cripto em BRL)
// - Yahoo Finance: ações, FIIs, ETFs, BDRs
// ============================================================

const axios = require("axios");

// ============================================================
// 🪙 COINGECKO — Cripto
// ============================================================
async function getCryptoPrice(symbol) {
  const res = await axios.get(
    `https://api.coingecko.com/api/v3/simple/price`,
    {
      params: {
        ids: symbol,
        vs_currencies: "brl"
      }
    }
  );

  return res.data[symbol].brl;
}

// ============================================================
// 📈 YAHOO FINANCE — Ações, FIIs, ETFs, BDRs
// ============================================================
const YahooFinance = require("yahoo-finance2").default;

// ⚙️ Opções vão no construtor (v3.x removeu setGlobalConfig)
const yahooFinance = new YahooFinance({
  queue: { concurrency: 2 },
  validation: { logErrors: false }
});

// Converte ticker da B3 para símbolo Yahoo
function paraSimboloYahoo(ticker) {
  const t = ticker.toUpperCase();

  if (t.startsWith("^")) return t;

  const criptos = [
    "BTC", "ETH", "SOL", "USDT", "USDC", "XRP", "ADA", "DOGE",
    "BNB", "LTC", "DOT", "MATIC", "LINK", "AVAX", "TRX", "ATOM",
    "NEAR", "APT", "ARB", "OP"
  ];
  if (criptos.includes(t)) return `${t}-USD`;

  return `${t}.SA`;
}

// Busca cotações em BATCH
async function buscarCotacoesYahoo(tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) return [];

  const simbolos = tickers.map(paraSimboloYahoo);
  const mapaSimbolo = {};
  tickers.forEach((t, i) => { mapaSimbolo[simbolos[i]] = t; });

  const LOTE = 50;
  const lotes = [];
  for (let i = 0; i < simbolos.length; i += LOTE) {
    lotes.push(simbolos.slice(i, i + LOTE));
  }

  const resultados = [];

  for (const lote of lotes) {
    try {
      const resposta = await yahooFinance.quote(lote);
      const lista = Array.isArray(resposta) ? resposta : [resposta];
      for (const r of lista) {
        if (!r || !r.regularMarketPrice) continue;
        resultados.push({
          ticker: mapaSimbolo[r.symbol] || r.symbol.replace(".SA", ""),
          preco: r.regularMarketPrice,
          variacao: r.regularMarketChangePercent || 0,
          nome: r.longName || r.shortName || r.symbol,
          volume: r.regularMarketVolume || 0,
          maxDia: r.regularMarketDayHigh || 0,
          minDia: r.regularMarketDayLow || 0
        });
      }
    } catch (e) {
      console.warn(`  ⚠️ Yahoo lote falhou: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, 500));
  }

  return resultados;
}

async function buscarCotacaoUnica(ticker) {
  const resultados = await buscarCotacoesYahoo([ticker]);
  return resultados[0] || null;
}

module.exports = {
  getCryptoPrice,
  paraSimboloYahoo,
  buscarCotacoesYahoo,
  buscarCotacaoUnica
};
