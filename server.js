const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 usar ENV (NUNCA deixar no código)
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;

let apiKey = null;

// 🔥 autenticação Pluggy
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
    throw new Error("Erro na autenticação");
  }
}

// 🔥 gerar connect token
app.get("/connect", async (req, res) => {
  try {
    if (!apiKey) await autenticar();

    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      {
        headers: {
          "X-API-KEY": apiKey
        }
      }
    );

    res.json({ accessToken: response.data.accessToken });

  } catch (e) {
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao gerar token" });
  }
});

// 🔥 pegar transações
app.get("/transacoes/:itemId", async (req, res) => {
  try {
    if (!apiKey) await autenticar();

    const response = await axios.get(
      `https://api.pluggy.ai/transactions?itemId=${req.params.itemId}`,
      {
        headers: {
          "X-API-KEY": apiKey
        }
      }
    );

    res.json(response.data);

  } catch (e) {
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao buscar transações" });
  }
});

// 🔥 webhook (Pluggy)
app.post("/webhook/pluggy", (req, res) => {
  const event = req.body;

  console.log("📩 Webhook recebido:", event.event);
  console.log("📌 Item ID:", event.itemId);

  res.status(200).json({ received: true });
});

// 🚀 start servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
