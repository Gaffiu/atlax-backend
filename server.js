import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 SUAS CHAVES PLUGGY
const CLIENT_ID = "SEU_CLIENT_ID";
const CLIENT_SECRET = "SEU_CLIENT_SECRET";

let accessToken = "";

// 🔥 GERAR TOKEN
async function gerarToken() {
  try {
    const res = await axios.post("https://api.pluggy.ai/auth", {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });

    accessToken = res.data.apiKey;
    console.log("Token Pluggy gerado");
  } catch (err) {
    console.error("Erro token:", err.response?.data || err.message);
  }
}

// 🔥 ROTA: CRIAR CONNECT TOKEN (frontend usa isso)
app.get("/connect", async (req, res) => {
  try {
    if (!accessToken) await gerarToken();

    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      {
        headers: { "X-API-KEY": accessToken }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// 🔥 ROTA: PEGAR TRANSAÇÕES
app.get("/transacoes/:itemId", async (req, res) => {
  try {
    const { itemId } = req.params;

    const response = await axios.get(
      `https://api.pluggy.ai/transactions?itemId=${itemId}`,
      {
        headers: { "X-API-KEY": accessToken }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

app.listen(PORT, async () => {
  console.log("Servidor rodando...");
  await gerarToken();
});
