const db = require("./firebase");
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const mercadopago = require("mercadopago");

mercadopago.configure({
  access_token: process.env.MP_TOKEN
});

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

app.post("/criar-usuario", async (req, res) => {
  const { uid } = req.body;

  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();

  if (!doc.exists) {
    await userRef.set({
      saldo: 0,
      criadoEm: new Date()
    });
  }

  res.json({ ok: true });
});

app.get("/saldo/:uid", async (req, res) => {
  const doc = await db.collection("users").doc(req.params.uid).get();

  if (!doc.exists) {
    return res.json({ saldo: 0 });
  }

  res.json({ saldo: doc.data().saldo });
});

app.post("/deposito", async (req, res) => {
  try {
    const { valor, uid } = req.body;

    const pagamento = await mercadopago.payment.create({
      transaction_amount: Number(valor),
      payment_method_id: "pix",
      payer: {
        email: "cliente@atlax.com"
      }
    });

    res.json({
      id: pagamento.body.id,
      qr_img: pagamento.body.point_of_interaction.transaction_data.qr_code_base64
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

app.post("/webhook/mp", async (req, res) => {
  try {
    const paymentId = req.body.data.id;

    const pagamento = await mercadopago.payment.findById(paymentId);

    if (pagamento.body.status === "approved") {

      const valor = pagamento.body.transaction_amount;

      // ⚠️ você precisa salvar uid junto no depósito (depois melhoramos isso)
      const uid = "TEMP_UID";

      const userRef = db.collection("users").doc(uid);
      const doc = await userRef.get();

      const saldoAtual = doc.data().saldo || 0;

      await userRef.update({
        saldo: saldoAtual + valor
      });

      console.log("💰 Depósito confirmado:", valor);
    }

    res.sendStatus(200);

  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/saque", async (req, res) => {
  const { uid, valor, pix } = req.body;

  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();

  if (!doc.exists) {
    return res.status(400).json({ erro: "Usuário não encontrado" });
  }

  const saldo = doc.data().saldo;

  if (valor > saldo) {
    return res.status(400).json({ erro: "Saldo insuficiente" });
  }

  await userRef.update({
    saldo: saldo - valor
  });

  await db.collection("saques").add({
    uid,
    valor,
    pix,
    status: "pendente",
    criadoEm: new Date()
  });

  res.json({ ok: true });
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
