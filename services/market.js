const axios = require("axios");

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

module.exports = { getCryptoPrice };

app.get("/preco/cripto/:symbol", async (req, res) => {
  try {
    const { getCryptoPrice } = require("./services/market");

    const price = await getCryptoPrice(req.params.symbol);

    res.json({ price });
  } catch (err) {
    res.status(500).json({ erro: "Erro preço" });
  }
});
