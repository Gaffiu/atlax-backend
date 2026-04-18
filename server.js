const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 COLOCA SUAS CHAVES DA PLUGGY AQUI
const CLIENT_ID = "f27b8426-cade-4df4-91ca-d9e0a589cb7f";
const CLIENT_SECRET = "c86ae357-bd21-4747-86c1-19d4c7aa0715";

let apiKey = null;

// 🔥 autenticação com Pluggy
async function autenticar(){
  const res = await axios.post("https://api.pluggy.ai/auth", {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET
  });

  apiKey = res.data.apiKey;
}

// 🔥 rota para gerar connectToken
app.get("/connect", async (req, res) => {
  try{
    if(!apiKey) await autenticar();

    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      { headers: { "X-API-KEY": apiKey } }
    );

    res.json({ accessToken: response.data.accessToken });

  }catch(e){
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao gerar token" });
  }
});

// 🔥 pegar transações
app.get("/transacoes/:itemId", async (req, res) => {
  try{
    if(!apiKey) await autenticar();

    const response = await axios.get(
      `https://api.pluggy.ai/transactions?itemId=${req.params.itemId}`,
      { headers: { "X-API-KEY": apiKey } }
    );

    res.json(response.data);

  }catch(e){
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao buscar transações" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));

app.get("/connect", async (req, res) => {
  const response = await fetch("https://api.pluggy.ai/connect_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.PLUGGY_CLIENT_ID,
      "X-API-SECRET": process.env.PLUGGY_CLIENT_SECRET
    }
  });

  const data = await response.json();
  res.json({ accessToken: data.accessToken });
});

app.get("/transacoes/:itemId", async (req, res) => {
  const itemId = req.params.itemId;

  const response = await fetch(`https://api.pluggy.ai/transactions?itemId=${itemId}`, {
    headers: {
      "X-API-KEY": process.env.PLUGGY_CLIENT_ID,
      "X-API-SECRET": process.env.PLUGGY_CLIENT_SECRET
    }
  });

  const data = await response.json();
  res.json(data);
});
