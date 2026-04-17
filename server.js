require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 Belvo config
const belvo = axios.create({
  baseURL: "https://sandbox.belvo.com",
  auth: {
    username: process.env.BELVO_ID,
    password: process.env.BELVO_SECRET
  }
});

// rota teste
app.get("/", (req, res) => {
  res.send("Atlax backend rodando 🚀");
});

// 🔗 conectar banco
app.post("/connect", async (req, res) => {
  try {
    const response = await belvo.post("/api/links/", {
      institution: "erebor_br_retail",
      username: "user",
      password: "pass"
    });

    res.json(response.data);
  } catch (err) {
    console.log(err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao conectar" });
  }
});

// 📊 transações
app.get("/transactions/:linkId", async (req, res) => {
  try {
    const response = await belvo.post("/api/transactions/", {
      link: req.params.linkId,
      date_from: "2025-01-01",
      date_to: "2025-12-31"
    });

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar transações" });
  }
});

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
