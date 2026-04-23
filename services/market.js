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
