import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// 🔍 Debug pra garantir deploy
app.get("/debug", (req, res) => {
  res.send("CODIGO NOVO 🚀");
});

// 🚀 Endpoint de teste REAL com Belvo
app.get("/connect-test", async (req, res) => {
  try {
    console.log("BATENDO CONNECT TEST 🚀");

    const response = await axios.post(
      "https://sandbox.belvo.com/api/links/",
      {
        institution: "ofmockbank_br_retail",
        username: "12345678901"
      },
      {
        auth: {
          username: process.env.BELVO_ID,
          password: process.env.BELVO_SECRET
        },
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("SUCESSO:", response.data);
    res.json(response.data);

  } catch (err) {
    console.log("ERRO REAL:", err.response?.data || err.message);
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// 🚀 Endpoint principal (corrigido)
app.post("/connect", async (req, res) => {
  try {
    const { username } = req.body;

    const response = await axios.post(
      "https://sandbox.belvo.com/api/links/",
      {
        institution: "ofmockbank_br_retail",
        username: username || "12345678901"
      },
      {
        auth: {
          username: process.env.BELVO_ID,
          password: process.env.BELVO_SECRET
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    console.log("ERRO CONNECT:", err.response?.data);
    res.status(400).json(err.response?.data || err.message);
  }
});

// 🔥 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
