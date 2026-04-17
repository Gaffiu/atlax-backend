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

// TESTE
app.get("/", (req, res) => {
  res.send("Atlax backend rodando 🚀");
});

// =======================
// 🔗 CONNECT (cria link)
// =======================
app.get("/connect", async (req, res) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/links/`,
      {
        institution: "belvo_test_bank", // banco fake sandbox
        username: "john_doe",
        password: "1234"
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
    res.status(500).json({
      error: err.response?.data || err.message
    });
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
    res.status(500).json({
      error: err.response?.data || err.message
    });
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
    res.status(500).json({
      error: err.response?.data || err.message
    });
  }
});

// PORTA
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});

app.get("/institutions", async (req, res) => {
  try {
    const response = await axios.get(
      "https://sandbox.belvo.com/api/institutions/",
      {
        auth: {
          username: process.env.BELVO_ID,
          password: process.env.BELVO_SECRET
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    res.status(500).json({
      error: err.response?.data || err.message
    });
  }
});
