console.log("🔥 Iniciando servidor...");

process.on("uncaughtException", (err) => console.error("💥 Erro:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { db, admin, firebasePronto } = require("./firebase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

console.log("📌 Firebase pronto:", firebasePronto);

const { MP_TOKEN } = process.env;
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 Mercado Pago configurado");
}

// ===== ROTAS =====

app.get("/", (req, res) => res.send("API Atlax 🚀"));

// Diagnóstico do Firestore
app.get("/ping-firestore", async (req, res) => {
  try {
    const ref = db.collection("ping").doc("teste");
    await ref.set({ ok: true, timestamp: new Date() });
    const snap = await ref.get();
    await ref.delete();
    res.json({ firestore: "online", data: snap.data() });
  } catch (e) {
    console.error("❌ Ping Firestore falhou:", e.message);
    res.status(500).json({ firestore: "offline", erro: e.message });
  }
});

// Diagnóstico do documento do usuário
app.get("/debug-usuario/:uid", async (req, res) => {
  try {
    if (!firebasePronto) return res.status(500).json({ erro: "Firebase offline" });
    const doc = await db.collection("users").doc(req.params.uid).get();
    if (!doc.exists) {
      return res.json({ existe: false, uid: req.params.uid });
    }
    res.json({
      existe: true,
      uid: req.params.uid,
      dados: doc.data()
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Saldo (leitura direta do servidor)
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  if (!firebasePronto) return res.status(500).json({ erro: "Firebase offline" });
  try {
    const doc = await db.collection("users").doc(req.user.uid).get({ source: "server" });
    const saldo = doc.data()?.saldo ?? 0;
    console.log(`📊 Saldo retornado para ${req.user.uid}: ${saldo}`);
    res.json({ saldo });
  } catch (e) {
    console.error("❌ Erro saldo:", e.message);
    res.status(500).json({ erro: "Erro ao buscar saldo" });
  }
});

// Depósito (QR Code original)
app.post("/deposito", authMiddleware, async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    const { valor } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });

    const pagamento = await payment.create({
      body: {
        transaction_amount: Number(valor),
        payment_method_id: "pix",
        payer: { email: "cliente@atlax.com" },
        metadata: { uid: req.user.uid }
      }
    });

    const qr = pagamento.point_of_interaction?.transaction_data;
    if (!qr) return res.status(500).json({ erro: "QR não gerado" });

    console.log(`✅ Pagamento criado: ${pagamento.id}`);
    res.json({
      id: pagamento.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code
    });
  } catch (err) {
    console.error("❌ Erro depósito:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// Verificar pagamento (com atualização usando set/merge)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });

    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);

    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;

      console.log(`✅ Aprovado! UID: ${uid}, Valor: R$ ${valor}`);

      if (uid && firebasePronto) {
        try {
          await db.collection("users").doc(uid).set({
            saldo: admin.firestore.FieldValue.increment(Number(valor)),
            atualizadoEm: new Date()
          }, { merge: true });

          console.log(`💰 Saldo atualizado (set/merge) no Firestore`);

          await db.collection("transactions").add({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
            criadoEm: new Date()
          });
          console.log(`📝 Transação registrada`);
        } catch (updateErr) {
          console.error("❌ Erro ao atualizar saldo:", updateErr.message);
        }
      } else {
        console.error("❌ UID ausente ou Firebase offline");
      }
    }

    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount
    });
  } catch (err) {
    console.error("❌ Erro ao verificar:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

// Webhook (também usa set/merge)
app.post("/webhook/mp", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId || !payment) return res.sendStatus(200);

    const pagamento = await payment.get({ id: paymentId });
    console.log(`📥 Webhook: ${pagamento.status}`);

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;

      if (uid && firebasePronto) {
        await db.collection("users").doc(uid).set({
          saldo: admin.firestore.FieldValue.increment(Number(valor)),
          atualizadoEm: new Date()
        }, { merge: true });
        console.log(`💰 Saldo atualizado via webhook (set/merge)`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro webhook:", err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
