console.log("🔥 Iniciando servidor...");

process.on("uncaughtException", (err) => console.error("💥 Erro não tratado:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise rejeitada:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { db, admin } = require("./firebase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");
const qrcode = require("qrcode"); // Agora vamos gerar QR code localmente

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const { MP_TOKEN, PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, GEMINI_API_KEY } = process.env;

console.log("🔧 Variáveis de ambiente:");
console.log("MP_TOKEN:", MP_TOKEN ? "✅" : "❌ (modo teste)");
console.log("PLUGGY_CLIENT_ID:", PLUGGY_CLIENT_ID ? "✅" : "❌");
console.log("GEMINI_API_KEY:", GEMINI_API_KEY ? "✅" : "❌");

// ==================== MERCADO PAGO ====================
let payment = null;
if (MP_TOKEN) {
  try {
    const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
    payment = new Payment(client);
    console.log("💳 Mercado Pago configurado");
  } catch (e) {
    console.error("Erro Mercado Pago:", e.message);
  }
}

// ==================== FUNÇÃO AUXILIAR ====================
async function garantirUsuario(uid) {
  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    console.log(`📄 Criando documento para ${uid}`);
    await ref.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
  }
  return ref;
}

// ==================== ROTAS ====================

app.get("/", (req, res) => res.send("API Atlax rodando 🚀"));

// 🔥 DEPÓSITO
app.post("/deposito", authMiddleware, async (req, res) => {
  console.log("📥 Requisição de depósito recebida:", req.body);
  const { valor } = req.body;
  if (!valor || valor <= 0) {
    return res.status(400).json({ erro: "Valor inválido" });
  }

  const uid = req.user.uid;
  await garantirUsuario(uid);

  // Tentar Mercado Pago real
  let pagamentoReal = null;
  if (payment) {
    try {
      console.log(`💰 Tentando criar pagamento real de R$ ${valor}`);
      pagamentoReal = await payment.create({
        body: {
          transaction_amount: Number(valor),
          payment_method_id: "pix",
          payer: { email: "cliente@atlax.com" },
          metadata: { uid }
        }
      });
      console.log("✅ Pagamento real criado:", pagamentoReal.id);
    } catch (mpErr) {
      console.error("❌ Erro Mercado Pago:", mpErr.response?.data || mpErr.message);
      console.log("⚠️ Seguindo com modo de teste...");
    }
  }

  // Se não conseguiu criar real, gera um teste automaticamente
  if (pagamentoReal && pagamentoReal.point_of_interaction?.transaction_data) {
    // Modo real
    const qr = pagamentoReal.point_of_interaction.transaction_data;
    
    // Salvar no Firestore
    await db.collection("pagamentos").doc(pagamentoReal.id.toString()).set({
      uid, valor: Number(valor), status: "pending", criadoEm: new Date()
    });

    return res.json({
      id: pagamentoReal.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code,
      modo: "real"
    });
  } else {
    // Modo teste
    const fakeId = "TEST" + Date.now();
    const qrCodeData = `TESTE-ATLAX-${fakeId}-${valor}`;
    
    // Gerar QR code com a biblioteca 'qrcode'
    let qrImageBase64;
    try {
      qrImageBase64 = await qrcode.toDataURL(qrCodeData, { width: 200, margin: 1 });
    } catch (qrErr) {
      console.error("Erro ao gerar QR code:", qrErr);
      // Fallback SVG manual (garantido)
      const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#f0f0f0"/>
        <text x="100" y="80" text-anchor="middle" font-size="14" fill="#333">QR Code</text>
        <text x="100" y="100" text-anchor="middle" font-size="11" fill="#666">PIX de Teste</text>
        <text x="100" y="120" text-anchor="middle" font-size="10" fill="#999">R$ ${valor}</text>
      </svg>`;
      qrImageBase64 = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    }

    // Salvar no Firestore
    await db.collection("pagamentos").doc(fakeId).set({
      uid, valor: Number(valor), status: "pending", criadoEm: new Date(), teste: true
    });

    console.log("🧪 Pagamento de teste criado:", fakeId);
    return res.json({
      id: fakeId,
      qr_img: qrImageBase64,
      copia_cola: qrCodeData,
      modo: "teste"
    });
  }
});

// 🔥 VERIFICAR PAGAMENTO
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}`);

    if (id.startsWith("TEST")) {
      const doc = await db.collection("pagamentos").doc(id).get();
      if (!doc.exists) return res.json({ status: "pending" });

      const data = doc.data();
      if (Date.now() - new Date(data.criadoEm).getTime() > 10000) {
        // Aprovar automaticamente
        await db.collection("users").doc(data.uid).update({
          saldo: admin.firestore.FieldValue.increment(Number(data.valor))
        });
        await db.collection("transactions").add({
          uid: data.uid, tipo: "deposito", valor: Number(data.valor), status: "aprovado", criadoEm: new Date()
        });
        await doc.ref.update({ status: "approved" });
        console.log(`✅ Teste aprovado: +R$ ${data.valor}`);
        return res.json({ status: "approved", amount: data.valor, modo: "teste" });
      }
      return res.json({ status: "pending", amount: data.valor, modo: "teste" });
    }

    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });

    const pagamento = await payment.get({ id });
    console.log(`📊 Status real: ${pagamento.status}`);

    if (pagamento.status === "approved") {
      const uid = pagamento.metadata?.uid;
      if (uid) {
        await garantirUsuario(uid);
        await db.collection("users").doc(uid).update({
          saldo: admin.firestore.FieldValue.increment(Number(pagamento.transaction_amount))
        });
        await db.collection("transactions").add({
          uid, tipo: "deposito", valor: pagamento.transaction_amount, status: "aprovado", criadoEm: new Date()
        });
        await db.collection("pagamentos").doc(id).update({ status: "approved" });
        console.log(`💰 Real aprovado: +R$ ${pagamento.transaction_amount}`);
      }
    }
    res.json({ status: pagamento.status, amount: pagamento.transaction_amount, modo: "real" });
  } catch (err) {
    console.error("❌ Erro ao verificar:", err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

// 🔥 SIMULAR APROVAÇÃO (PARA TESTES)
app.post("/simular-aprovacao/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection("pagamentos").doc(id).get();
    if (!doc.exists) return res.status(404).json({ erro: "Pagamento não encontrado" });

    const data = doc.data();
    await db.collection("users").doc(data.uid).update({
      saldo: admin.firestore.FieldValue.increment(Number(data.valor))
    });
    await db.collection("transactions").add({
      uid: data.uid, tipo: "deposito", valor: Number(data.valor), status: "aprovado", criadoEm: new Date()
    });
    await doc.ref.update({ status: "approved" });
    console.log(`✅ Aprovação manual: +R$ ${data.valor}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao simular" });
  }
});

// 🔥 SALDO
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ erro: "Não autorizado" });
    const ref = await garantirUsuario(req.params.uid);
    const doc = await ref.get();
    res.json({ saldo: doc.data()?.saldo ?? 0 });
  } catch (err) {
    console.error("❌ Erro saldo:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 🔥 SAQUE
app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    const uid = req.user.uid;
    const ref = await garantirUsuario(uid);
    const doc = await ref.get();
    const saldo = doc.data()?.saldo ?? 0;
    if (valor > saldo) return res.status(400).json({ erro: "Saldo insuficiente" });
    await ref.update({ saldo: admin.firestore.FieldValue.increment(-Number(valor)) });
    await db.collection("transactions").add({
      uid, tipo: "saque", valor, status: "pendente", criadoEm: new Date()
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro saque:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 🔥 INVESTIR
app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;
    const ref = await garantirUsuario(uid);
    const doc = await ref.get();
    const saldo = doc.data()?.saldo ?? 0;
    if (valor > saldo) return res.status(400).json({ erro: "Saldo insuficiente" });
    await ref.update({
      [`investimentos.${tipo}`]: admin.firestore.FieldValue.increment(Number(valor)),
      saldo: admin.firestore.FieldValue.increment(-Number(valor))
    });
    await db.collection("transactions").add({
      uid, tipo: "investimento", categoria: tipo, valor, criadoEm: new Date()
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro investir:", err);
    res.status(400).json({ erro: err.message });
  }
});

// 🔥 IA
app.post("/ia", authMiddleware, async (req, res) => {
  const { mensagem } = req.body;
  res.json({ resposta: "Você disse: " + mensagem });
});

// 🚀 START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔧 Modo: ${payment ? "PRODUÇÃO" : "TESTE (geração local de QR)"}`);
});
