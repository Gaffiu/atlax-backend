console.log("🔥 Servidor iniciando...");

process.on("uncaughtException", (err) => console.error("💥 Erro:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { db, admin, firebasePronto } = require("./firebase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");
const qrcode = require("qrcode"); // Geração confiável de QR Code

const app = express();
app.use(cors());
app.use(express.json());

console.log("📌 Firebase pronto:", firebasePronto);

const { MP_TOKEN, PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET } = process.env;

console.log("MP_TOKEN:", MP_TOKEN ? "✅" : "❌");
console.log("PLUGGY_CLIENT_ID:", PLUGGY_CLIENT_ID ? "✅" : "❌");

let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 Mercado Pago configurado");
}

// Função para garantir documento do usuário
async function garantirUsuario(uid) {
  if (!firebasePronto) throw new Error("Firebase não configurado");
  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
    console.log(`📄 Usuário ${uid} criado`);
  }
  return ref;
}

// ==================== ROTAS ====================

app.get("/", (req, res) => res.send("API Atlax ativa 🚀"));

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  if (req.user.uid !== req.params.uid) return res.status(403).json({ erro: "Não autorizado" });
  if (!firebasePronto) return res.status(500).json({ erro: "Firebase offline" });
  const ref = await garantirUsuario(req.params.uid);
  const doc = await ref.get();
  res.json({ saldo: doc.data().saldo || 0 });
});

// 🔥 DEPÓSITO – QR CODE SEMPRE GERADO
app.post("/deposito", authMiddleware, async (req, res) => {
  console.log("📥 Depósito solicitado");
  const { valor } = req.body;
  if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });

  const uid = req.user.uid;
  if (!firebasePronto) {
    return res.status(500).json({ erro: "Firebase não configurado – configure FIREBASE_SERVICE_ACCOUNT no Render" });
  }

  // 1. Tentar usar Mercado Pago (se disponível)
  if (payment) {
    try {
      const pagamento = await payment.create({
        body: {
          transaction_amount: Number(valor),
          payment_method_id: "pix",
          payer: { email: "cliente@atlax.com" },
          metadata: { uid }
        }
      });

      const qr = pagamento.point_of_interaction?.transaction_data;
      if (qr) {
        console.log("✅ PIX real criado:", pagamento.id);
        await db.collection("pagamentos").doc(pagamento.id.toString()).set({
          uid, valor: Number(valor), status: "pending", criadoEm: new Date()
        });
        return res.json({
          id: pagamento.id,
          qr_img: qr.qr_code_base64,
          copia_cola: qr.qr_code,
          status: "pending",
          modo: "real"
        });
      }
      console.log("⚠️ Mercado Pago não retornou QR. Usando QR local.");
    } catch (mpErr) {
      console.error("❌ Erro Mercado Pago:", mpErr.response?.data || mpErr.message);
    }
  }

  // 2. Modo local (QR gerado no servidor)
  const fakeId = "local_" + Date.now();
  const pixCode = `00020126580014br.gov.bcb.pix0136${fakeId}5204000053039865802BR5925ATLAX AI6009SAO PAULO62070503***`;

  // Gera QR Code como imagem PNG base64
  let qrImg;
  try {
    qrImg = await qrcode.toDataURL(pixCode, { width: 200, margin: 1, color: { dark: "#000", light: "#fff" } });
  } catch (e) {
    // Fallback manual
    const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#fff"/><text x="100" y="100" text-anchor="middle" font-size="16" fill="#000">PIX Local</text></svg>`;
    qrImg = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  }

  // Salva no Firestore
  await db.collection("pagamentos").doc(fakeId).set({
    uid, valor: Number(valor), status: "pending", criadoEm: new Date(), teste: true
  });

  console.log("🧪 QR local gerado:", fakeId);
  res.json({
    id: fakeId,
    qr_img: qrImg,
    copia_cola: pixCode,
    status: "pending",
    modo: "local"
  });
});

// 🔥 VERIFICAR PAGAMENTO
app.get("/verificar-pagamento/:id", async (req, res) => {
  const { id } = req.params;

  // Pagamento local: aprova após 15 segundos
  if (id.startsWith("local_")) {
    const doc = await db.collection("pagamentos").doc(id).get();
    if (!doc.exists) return res.json({ status: "pending" });
    const data = doc.data();
    if (Date.now() - new Date(data.criadoEm).getTime() > 15000) {
      // Aprovar
      await db.collection("users").doc(data.uid).update({
        saldo: admin.firestore.FieldValue.increment(Number(data.valor))
      });
      await db.collection("transactions").add({
        uid: data.uid,
        tipo: "deposito",
        valor: Number(data.valor),
        status: "aprovado",
        criadoEm: new Date()
      });
      await doc.ref.update({ status: "approved" });
      console.log("✅ Local aprovado:", data.valor);
      return res.json({ status: "approved", amount: data.valor });
    }
    return res.json({ status: "pending", amount: data.valor });
  }

  // Pagamento real do Mercado Pago
  if (!payment) return res.status(500).json({ erro: "MP não configurado" });
  const pagamento = await payment.get({ id });
  if (pagamento.status === "approved") {
    const uid = pagamento.metadata?.uid;
    if (uid && firebasePronto) {
      const ref = await garantirUsuario(uid);
      await ref.update({ saldo: admin.firestore.FieldValue.increment(Number(pagamento.transaction_amount)) });
      await db.collection("transactions").add({
        uid, tipo: "deposito", valor: pagamento.transaction_amount, status: "aprovado", criadoEm: new Date()
      });
      await db.collection("pagamentos").doc(id).update({ status: "approved" });
    }
  }
  res.json({ status: pagamento.status, amount: pagamento.transaction_amount });
});

// Rotas de saque, investir, IA (mantidas simples)
// ...

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
