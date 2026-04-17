import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔐 suas credenciais Belvo (sandbox)
const BELVO_ID = "SEU_ID";
const BELVO_SECRET = "SEU_SECRET";

// 🔎 listar instituições (debug)
app.get("/institutions", async (req, res) => {
  try {
    const response = await axios.get(
      "https://sandbox.belvo.com/api/institutions/",
      {
        auth: {
          username: BELVO_ID,
          password: BELVO_SECRET,
        },
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// ✅ TESTE FIXO (esse TEM que funcionar)
app.get("/connect-test", async (req, res) => {
  try {
    const body = {
      institution: "ofmockbank_br_retail",
      username: "12345678901",
    };

    console.log("BODY:", body);

    const response = await axios.post(
      "https://sandbox.belvo.com/api/links/",
      body,
      {
        auth: {
          username: BELVO_ID,
          password: BELVO_SECRET,
        },
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error("ERRO:", err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

// ⚠️ ROTA REAL (corrigida)
app.post("/connect", async (req, res) => {
  try {
    const { username } = req.body;

    const body = {
      institution: "ofmockbank_br_retail", // 🔥 FIXO PRA NÃO DAR ERRO
      username,
    };

    console.log("BODY RECEBIDO:", body);

    const response = await axios.post(
      "https://sandbox.belvo.com/api/links/",
      body,
      {
        auth: {
          username: BELVO_ID,
          password: BELVO_SECRET,
        },
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error("ERRO:", err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000 🚀");
});
