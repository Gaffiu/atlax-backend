// ============================================================
// services/market.js
// Serviço de cotações
// - getCryptoPrice: CoinGecko (cripto em BRL)
// - Yahoo Finance: ações, FIIs, ETFs, BDRs
// ============================================================

const axios = require("axios");

// ============================================================
// 🪙 COINGECKO — Cripto
// ============================================================
async function getCryptoPrice(symbol) {
  const res = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price",
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
// 📈 YAHOO FINANCE
// ============================================================
const YahooFinance = require("yahoo-finance2").default;

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
  if (criptos.includes(t)) return t + "-USD";

  return t + ".SA";
}

// Busca cotações em batch + retry individual
async function buscarCotacoesYahoo(tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return [];
  }

  const simbolos = [];
  for (let i = 0; i < tickers.length; i++) {
    simbolos.push(paraSimboloYahoo(tickers[i]));
  }

  const mapaSimbolo = {};
  for (let i = 0; i < tickers.length; i++) {
    mapaSimbolo[simbolos[i]] = tickers[i];
  }

  // Dividir em lotes de 20
  const LOTE = 20;
  const lotes = [];
  let pos = 0;
  while (pos < simbolos.length) {
    lotes.push(simbolos.slice(pos, pos + LOTE));
    pos = pos + LOTE;
  }

  const resultadosMap = new Map();

  // 1º passe: batch
  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];
    try {
      const resposta = await yahooFinance.quote(lote);
      const lista = Array.isArray(resposta) ? resposta : [resposta];
      for (let j = 0; j < lista.length; j++) {
        const r = lista[j];
        if (r && r.regularMarketPrice) {
          resultadosMap.set(r.symbol, r);
        }
      }
    } catch (e) {
      console.warn("  ⚠️ Yahoo lote falhou: " + e.message);
    }
    await new Promise(function (res) { setTimeout(res, 300); });
  }

  // 2º passe: retry individual
  const faltantes = [];
  for (let i = 0; i < simbolos.length; i++) {
    if (!resultadosMap.has(simbolos[i])) {
      faltantes.push(simbolos[i]);
    }
  }

  if (faltantes.length > 0) {
    console.log("  🔄 Retry individual para " + faltantes.length + " tickers...");
    for (let i = 0; i < faltantes.length; i++) {
      const simbolo = faltantes[i];
      try {
        const r = await yahooFinance.quote(simbolo);
        const item = Array.isArray(r) ? r[0] : r;
        if (item && item.regularMarketPrice) {
          resultadosMap.set(item.symbol, item);
        }
      } catch (e) {
        // Silencioso
      }
      await new Promise(function (res) { setTimeout(res, 150); });
    }
  }

  // Converter para array de retorno
  const resultados = [];
  resultadosMap.forEach(function (r) {
    let tickerOriginal = mapaSimbolo[r.symbol];
    if (!tickerOriginal) {
      tickerOriginal = r.symbol.replace(".SA", "");
    }
    resultados.push({
      ticker: tickerOriginal,
      preco: r.regularMarketPrice,
      variacao: r.regularMarketChangePercent || 0,
      nome: r.longName || r.shortName || r.symbol,
      volume: r.regularMarketVolume || 0,
      maxDia: r.regularMarketDayHigh || 0,
      minDia: r.regularMarketDayLow || 0
    });
  });

  return resultados;
}

// Busca cotação de UM ticker
async function buscarCotacaoUnica(ticker) {
  const resultados = await buscarCotacoesYahoo([ticker]);
  if (resultados.length === 0) return null;
  return resultados[0];
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getCryptoPrice: getCryptoPrice,
  paraSimboloYahoo: paraSimboloYahoo,
  buscarCotacoesYahoo: buscarCotacoesYahoo,
  buscarCotacaoUnica: buscarCotacaoUnica
};
