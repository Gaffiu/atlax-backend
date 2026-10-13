// ============================================================
// services/market.js
// Serviço centralizado de cotações
// - getCryptoPrice: CoinGecko (cripto em BRL)
// - Yahoo Finance: ações, FIIs, ETFs, BDRs (grátis, sem limite)
// ============================================================

const axios = require("axios");

// ============================================================
// 🪙 COINGECKO — Cripto (função original mantida)
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
const yahooFinance = new YahooFinance();

// ⚙️ Configuração global: limita concorrência para não sobrecarregar o Yahoo
yahooFinance.setGlobalConfig({
  queue: { concurrency: 2 },
  validation: { logErrors: false }
});

// ------------------------------------------------------------
// Converte ticker da B3 para o símbolo do Yahoo
// Exemplos:
//   "PETR4"  → "PETR4.SA"
//   "HGLG11" → "HGLG11.SA"
//   "AAPL34" → "AAPL34.SA"
//   "BTC"    → "BTC-USD"
//   "^BVSP"  → "^BVSP" (não altera)
// ------------------------------------------------------------
function paraSimboloYahoo(ticker) {
  const t = ticker.toUpperCase();

  // Índices globais já vêm com ^
  if (t.startsWith("^")) return t;

  // Criptos conhecidas → sufixo -USD
  const criptos = [
    "BTC", "ETH", "SOL", "USDT", "USDC", "XRP", "ADA", "DOGE",
    "BNB", "LTC", "DOT", "MATIC", "LINK", "AVAX", "TRX", "ATOM",
    "NEAR", "APT", "ARB", "OP"
  ];
  if (criptos.includes(t)) return `${t}-USD`;

  // Padrão B3 → .SA
  return `${t}.SA`;
}

// ------------------------------------------------------------
// Busca cotações em BATCH (até 50 símbolos por chamada)
// Retorna array com { symbol, preco, variacao, nome, ... }
// ------------------------------------------------------------
async function buscarCotacoesYahoo(tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) return [];

  const simbolos = tickers.map(paraSimboloYahoo);
  const mapaSimbolo = {};
  tickers.forEach((t, i) => { mapaSimbolo[simbolos[i]] = t; });

  // Dividir em lotes de 50 (limite do Yahoo)
  const LOTE = 50;
  const lotes = [];
  for (let i = 0; i < simbolos.length; i += LOTE) {
    lotes.push(simbolos.slice(i, i + LOTE));
  }

  const resultados = [];

  for (const lote of lotes) {
    try {
      const resposta = await yahooFinance.quote(lote);
      for (const r of resposta) {
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
    // Pausa entre lotes
    await new Promise(res => setTimeout(res, 500));
  }

  return resultados;
}

// ------------------------------------------------------------
// Busca cotação de UM ativo específico
// ------------------------------------------------------------
async function buscarCotacaoUnica(ticker) {
  const resultados = await buscarCotacoesYahoo([ticker]);
  return resultados[0] || null;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  // Cripto (original)
  getCryptoPrice,
  // Yahoo (novo)
  paraSimboloYahoo,
  buscarCotacoesYahoo,
  buscarCotacaoUnica
};
