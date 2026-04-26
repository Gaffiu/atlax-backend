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

// ========== FUNÇÃO AUXILIAR (CRIA DOCUMENTO SE NÃO EXISTIR) ==========
async function garantirDocumento(uid) {
  if (!firebasePronto) throw new Error("Firebase offline");
  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
    console.log(`📄 Documento criado para ${uid}`);
  }
  return ref;
}

// ========== ROTAS ==========

app.get("/", (req, res) => res.send("API Atlax 🚀"));

// Resetar saldo (para testes)
app.post("/reset-saldo", authMiddleware, async (req, res) => {
  await garantirDocumento(req.user.uid);
  await db.collection("users").doc(req.user.uid).update({ saldo: 0 });
  res.json({ ok: true, message: "Saldo zerado" });
});

// Saldo
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    if (!firebasePronto) return res.status(500).json({ erro: "Firebase offline" });
    await garantirDocumento(req.user.uid);
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

// 🔥 VERIFICAR PAGAMENTO (COM RETORNO DO SALDO ATUALIZADO)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });

    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);

    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    let saldoAtualizado = null;

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;

      console.log(`✅ Aprovado! UID: ${uid}, Valor: R$ ${valor}`);

      if (uid && firebasePronto) {
        await garantirDocumento(uid);
        await db.collection("users").doc(uid).set({
          saldo: admin.firestore.FieldValue.increment(Number(valor)),
          atualizadoEm: new Date()
        }, { merge: true });
        console.log(`💰 Saldo incrementado`);

        await db.collection("transactions").add({
          uid,
          tipo: "deposito",
          valor: Number(valor),
          status: "aprovado",
          criadoEm: new Date()
        });

        // Lê o saldo atualizado para retornar para o front-end
        const doc = await db.collection("users").doc(uid).get();
        saldoAtualizado = doc.data()?.saldo ?? null;
        console.log(`📊 Saldo atualizado lido: ${saldoAtualizado}`);
      }
    }

    // Sempre retorna o status e, se disponível, o saldo atualizado
    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount,
      saldo: saldoAtualizado
    });
  } catch (err) {
    console.error("❌ Erro ao verificar:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

// Webhook
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
        await garantirDocumento(uid);
        await db.collection("users").doc(uid).set({
          saldo: admin.firestore.FieldValue.increment(Number(valor)),
          atualizadoEm: new Date()
        }, { merge: true });
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
