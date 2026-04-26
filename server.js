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

const { MP_TOKEN } = process.env;
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

// 🔐 Middleware que CRIA o documento do usuário ANTES de qualquer rota
app.use(authMiddleware, async (req, res, next) => {
  if (!firebasePronto) return next();
  try {
    const uid = req.user.uid;
    const ref = db.collection("users").doc(uid);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
      console.log(`📄 Documento criado para ${uid}`);
    }
  } catch (e) {
    console.error("❌ Erro no middleware de criação:", e.message);
  }
  next();
});

// ===== ROTAS =====
app.get("/", (req, res) => res.send("API Atlax 🚀"));

// Rota de diagnóstico
app.get("/teste-firestore", async (req, res) => {
  try {
    const ref = db.collection("teste").doc("diag");
    await ref.set({ msg: "ok", ts: new Date() });
    const snap = await ref.get();
    await ref.delete();
    res.json({ ok: true, data: snap.data() });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Saldo (leitura simples)
app.get("/saldo/:uid", async (req, res) => {
  try {
    if (!firebasePronto) return res.status(500).json({ erro: "Firebase offline" });
    const doc = await db.collection("users").doc(req.user.uid).get();
    const saldo = doc.data()?.saldo ?? 0;
    console.log(`📊 Saldo de ${req.user.uid}: ${saldo}`);
    res.json({ saldo });
  } catch (e) {
    console.error("❌ Erro saldo:", e.message);
    res.status(500).json({ erro: "Erro ao buscar saldo" });
  }
});

// Depósito (QR Code original)
app.post("/deposito", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
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
    res.json({ id: pagamento.id, qr_img: qr.qr_code_base64, copia_cola: qr.qr_code });
  } catch (err) {
    console.error("❌ Erro depósito:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 VERIFICAR PAGAMENTO (SEMPRE RETORNA O SALDO)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);

    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    let saldo = null;

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;

      console.log(`✅ Aprovado! UID: ${uid}, Valor: R$ ${valor}`);

      if (uid && firebasePronto) {
        try {
          const ref = db.collection("users").doc(uid);

          // Incrementa o saldo
          await ref.set({
            saldo: admin.firestore.FieldValue.increment(Number(valor)),
            atualizadoEm: new Date()
          }, { merge: true });
          console.log(`💰 Saldo incrementado`);

          // Registra transação
          await db.collection("transactions").add({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
            criadoEm: new Date()
          });

          // 🔁 Lê o saldo atualizado para garantir que está correto
          const doc = await ref.get();
          saldo = doc.data()?.saldo ?? 0;
          console.log(`📊 Saldo lido após incremento: ${saldo}`);
        } catch (updateErr) {
          console.error("❌ Erro ao atualizar saldo:", updateErr.message);
        }
      }
    }

    // 🔁 Sempre retorna o campo 'saldo'
    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount,
      saldo: saldo
    });
  } catch (err) {
    console.error("❌ Erro ao verificar:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
