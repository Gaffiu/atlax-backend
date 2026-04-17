const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 suas credenciais via Render ENV
const BELVO_ID = process.env.BELVO_ID;
const BELVO_SECRET = process.env.BELVO_SECRET;

const BASE_URL = "https://sandbox.belvo.com";

// ========================
// TESTE
// ========================
app.get("/", (req, res) => {
  res.send("Backend Atlax rodando 🚀");
});

// ========================
// 🔗 CONNECT (CRIA LINK)
// ========================
app.get("/connect", async (req, res) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/links/`,
      {
        institution: "erebor_br_retail",
        username: "user_good",
        password: "pass_good"
      },
      {
        auth: {
          username: BELVO_ID,
          password: BELVO_SECRET
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.log(err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

// ========================
// 💳 CONTAS
// ========================
app.get("/accounts/:linkId", async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/api/accounts/?link=${req.params.linkId}`,
      {
        auth: {
          username: BELVO_ID,
          password: BELVO_SECRET
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// ========================
// 💸 TRANSAÇÕES
// ========================
app.get("/transactions/:linkId", async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/api/transactions/?link=${req.params.linkId}`,
      {
        auth: {
          username: BELVO_ID,
          password: BELVO_SECRET
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// ========================
app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000 🚀");
});
