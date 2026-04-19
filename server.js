const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 SUAS CHAVES
const CLIENT_ID = "f27b8426-cade-4df4-91ca-d9e0a589cb7f";
const CLIENT_SECRET = "c86ae357-bd21-4747-86c1-19d4c7aa0715";

let apiKey = null;

// 🔥 AUTENTICAR NA PLUGGY
async function autenticar() {
  try {
    const res = await axios.post("https://api.pluggy.ai/auth", {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });

    apiKey = res.data.apiKey;
    console.log("🔑 API KEY gerada");
  } catch (e) {
    console.log("Erro auth:", e.response?.data || e.message);
  }
}

// 🔥 GERAR CONNECT TOKEN
app.get("/connect", async (req, res) => {
  try {
    if (!apiKey) await autenticar();

    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      {
        headers: { "X-API-KEY": apiKey }
      }
    );

    res.json({ accessToken: response.data.accessToken });

  } catch (e) {
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao gerar token" });
  }
});

// 🔥 PEGAR TRANSAÇÕES
app.get("/transacoes/:itemId", async (req, res) => {
  try {
    if (!apiKey) await autenticar();

    const response = await axios.get(
      `https://api.pluggy.ai/transactions?itemId=${req.params.itemId}`,
      {
        headers: { "X-API-KEY": apiKey }
      }
    );

    res.json(response.data);

  } catch (e) {
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao buscar transações" });
  }
});

// 🔥 WEBHOOK (OBRIGATÓRIO)
app.post("/webhook/pluggy", (req, res) => {
  const event = req.body;

  console.log("📩 Webhook recebido:", event.event);
  console.log("📌 Item ID:", event.itemId);

  res.status(200).json({ received: true });
});

// 🚀 START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor rodando na porta " + PORT));
