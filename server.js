const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 ENV (Render)
const BELVO_ID = process.env.BELVO_ID;
const BELVO_SECRET = process.env.BELVO_SECRET;

// 🔥 BASE BELVO
const BASE_URL = "https://sandbox.belvo.com/api";

// =======================
// 🧪 TESTE ROOT
// =======================
app.get("/", (req, res) => {
  res.send("Atlax backend rodando 🚀");
});

// =======================
// 🏦 LISTAR INSTITUIÇÕES
// =======================
app.get("/institutions", async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/institutions/`,
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

// =======================
// 🔗 CONNECT (CRIAR LINK)
// =======================
app.get("/connect", async (req, res) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/links/`,
      {
        // ✅ INSTITUIÇÃO CORRETA (sandbox funcionando)
        institution: "ofmockbank_br_retail",

        // ✅ CPF fake válido
        username: "12345678901"
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
    res.status(500).json(err.response?.data || err.message);
  }
});

// =======================
// 💳 CONTAS
// =======================
app.get("/accounts/:linkId", async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/accounts/?link=${req.params.linkId}`,
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

// =======================
// 💸 TRANSAÇÕES
// =======================
app.get("/transactions/:linkId", async (req, res) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/transactions/`,
      {
        link: req.params.linkId,
        date_from: "2024-01-01",
        date_to: "2025-12-31"
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
    res.status(500).json(err.response?.data || err.message);
  }
});

// =======================
// 🚀 START
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
