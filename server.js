const db = require("./firebase");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const app = express();
app.use(cors());
app.use(express.json());

let payment;

if (!process.env.MP_TOKEN) {
  console.error("❌ MP_TOKEN não definido");
} else {
  const client = new MercadoPagoConfig({
    accessToken: process.env.MP_TOKEN
  });

  payment = new Payment(client);
}

// 🔐 CONFIG PLUGGY
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;

let apiKey = null;

// 🔥 autenticar pluggy
async function autenticar() {
  const res = await axios.post("https://api.pluggy.ai/auth", {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET
  });

  apiKey = res.data.apiKey;
}

// 🔥 CONNECT
app.get("/connect", async (req, res) => {
  try {
    if (!apiKey) await autenticar();

    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      {
        headers: { "X-API-KEY": apiKey }
      }
    );

    res.json({ accessToken: response.data.accessToken });

  } catch (e) {
    console.log(e.response?.data || e.message);
    res.status(500).json({ erro: "Erro connect" });
  }
});

// 🔥 CRIAR USUÁRIO
app.post("/criar-usuario", async (req, res) => {
  const { uid } = req.body;

  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();

  if (!doc.exists) {
    await ref.set({
      saldo: 0,
      criadoEm: new Date()
    });
  }

  res.json({ ok: true });
});

// 🔥 SALDO
app.get("/saldo/:uid", async (req, res) => {
  const doc = await db.collection("users").doc(req.params.uid).get();

  if (!doc.exists) return res.json({ saldo: 0 });

  res.json({ saldo: doc.data().saldo });
});

// 🔥 GERAR PIX (CORRIGIDO)
app.post("/deposito", async (req, res) => {
  try {
    const { valor, uid } = req.body;

    if (!valor || valor <= 0) {
      return res.status(400).json({ erro: "Valor inválido" });
    }

    const pagamento = await mercadopago.payment.create({
      transaction_amount: Number(valor),
      payment_method_id: "pix",
      payer: {
        email: "cliente@atlax.com"
      },
      metadata: {
        uid // 🔥 salva usuário no pagamento
      }
    });

    const qr = pagamento.body.point_of_interaction.transaction_data;

    res.json({
      id: pagamento.body.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code
    });

  } catch (err) {
    console.log("Erro MP:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 WEBHOOK MERCADO PAGO (ATUALIZA SALDO)
app.post("/webhook/mp", async (req, res) => {
  try {
    const paymentId = req.body.data.id;

    const pagamento = await mercadopago.payment.findById(paymentId);

    if (pagamento.body.status === "approved") {

      const valor = pagamento.body.transaction_amount;
      const uid = pagamento.body.metadata?.uid;

      if (!uid) return res.sendStatus(200);

      const ref = db.collection("users").doc(uid);
      const doc = await ref.get();

      const saldoAtual = doc.data()?.saldo || 0;

      await ref.set({
        saldo: saldoAtual + valor
      }, { merge: true });

      console.log("💰 Depósito aprovado:", valor);
    }

    res.sendStatus(200);

  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

// 🔥 SAQUE
app.post("/saque", async (req, res) => {
  const { uid, valor, pix } = req.body;

  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();

  if (!doc.exists) {
    return res.status(400).json({ erro: "Usuário não existe" });
  }

  const saldo = doc.data().saldo;

  if (valor > saldo) {
    return res.status(400).json({ erro: "Saldo insuficiente" });
  }

  await ref.update({ saldo: saldo - valor });

  await db.collection("saques").add({
    uid,
    valor,
    pix,
    status: "pendente",
    criadoEm: new Date()
  });

  res.json({ ok: true });
});

// 🚀 START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("🚀 Rodando na porta " + PORT);
});
