console.log("🔥 Iniciando servidor...");

process.on("uncaughtException", (err) => console.error("💥 Erro não tratado:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise rejeitada:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { db, admin } = require("./firebase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const { analisarUsuario } = require("./services/ai");
const authMiddleware = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

// 🧪 TESTE RÁPIDO DO FIRESTORE
(async () => {
  try {
    const testDoc = db.collection("test").doc("ping");
    await testDoc.set({ msg: "ok", timestamp: new Date() });
    const snap = await testDoc.get();
    console.log("📌 Firestore OK:", snap.data());
    await testDoc.delete();
  } catch (e) {
    console.error("❌ FALHA CRÍTICA NO FIRESTORE:", e.message);
    console.error("Verifique a variável FIREBASE_SERVICE_ACCOUNT no Render/Replit ou as regras de segurança.");
  }
})();

// ⚙️ MIDDLEWARE: GARANTIR QUE O USUÁRIO EXISTE ANTES DE TUDO
async function garantirDocumento(req, res, next) {
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      await userRef.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
      console.log(`📄 Documento criado para ${uid}`);
    }
    req.userRef = userRef;
    req.userData = userDoc.exists ? userDoc.data() : { saldo: 0 };
    next();
  } catch (e) {
    console.error("❌ Erro no middleware garantirDocumento:", e.message);
    res.status(500).json({ erro: "Erro ao acessar dados do usuário" });
  }
}

// Variáveis de ambiente
const { MP_TOKEN, PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, GEMINI_API_KEY } = process.env;
console.log("MP_TOKEN:", MP_TOKEN ? "✅" : "❌");
console.log("PLUGGY_CLIENT_ID:", PLUGGY_CLIENT_ID ? "✅" : "❌");
console.log("GEMINI_API_KEY:", GEMINI_API_KEY ? "✅" : "❌");

// Mercado Pago
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

// Pluggy
let apiKey = null;
async function autenticarPluggy() {
  try {
    const res = await axios.post("https://api.pluggy.ai/auth", {
      clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET
    });
    apiKey = res.data.apiKey;
    console.log("🔑 Pluggy autenticado");
  } catch (e) {
    console.error("Pluggy erro:", e.message);
  }
}

// ===== ROTAS =====

app.get("/", (req, res) => res.send("API Atlax 🚀"));

// Pluggy
app.get("/connect", async (req, res) => {
  if (!apiKey) await autenticarPluggy();
  if (!apiKey) return res.status(500).json({ erro: "Pluggy não configurado" });
  const r = await axios.post("https://api.pluggy.ai/connect_token", {}, { headers: { "X-API-KEY": apiKey } });
  res.json({ accessToken: r.data.accessToken });
});

app.get("/transacoes/:itemId", authMiddleware, async (req, res) => {
  if (!apiKey) await autenticarPluggy();
  const r = await axios.get(`https://api.pluggy.ai/items/${req.params.itemId}/transactions`, {
    headers: { "X-API-KEY": apiKey }
  });
  res.json(r.data);
});

// Usuário (com middleware)
app.post("/criar-usuario", authMiddleware, garantirDocumento, (req, res) => {
  res.json({ ok: true, saldo: req.userData.saldo });
});

// Saldo (com middleware)
app.get("/saldo/:uid", authMiddleware, garantirDocumento, (req, res) => {
  if (req.user.uid !== req.params.uid) return res.status(403).json({ erro: "Não autorizado" });
  res.json({ saldo: req.userData.saldo });
});

// Extrato
app.get("/extrato/:uid", authMiddleware, garantirDocumento, async (req, res) => {
  if (req.user.uid !== req.params.uid) return res.status(403).json({ erro: "Não autorizado" });
  const snap = await db.collection("transactions").where("uid", "==", req.params.uid)
    .orderBy("criadoEm", "desc").get();
  res.json(snap.docs.map(d => d.data()));
});

// ===== DEPÓSITO =====
app.post("/deposito", authMiddleware, garantirDocumento, async (req, res) => {
  const { valor } = req.body;
  if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });

  // Tenta usar Mercado Pago se configurado
  if (payment) {
    try {
      const pagamento = await payment.create({
        body: {
          transaction_amount: Number(valor),
          payment_method_id: "pix",
          payer: { email: "cliente@atlax.com" },
          metadata: { uid: req.user.uid }
        }
      });

      const qr = pagamento.point_of_interaction?.transaction_data;
      if (!qr) throw new Error("QR não gerado");

      await db.collection("pagamentos").doc(pagamento.id.toString()).set({
        uid: req.user.uid, valor: Number(valor), status: "pending", criadoEm: new Date()
      });

      console.log(`✅ Pagamento real criado: ${pagamento.id}`);
      return res.json({
        id: pagamento.id,
        qr_img: qr.qr_code_base64,
        copia_cola: qr.qr_code,
        modo: "real"
      });

    } catch (e) {
      console.error("❌ Erro Mercado Pago:", e.response?.data || e.message);
      // Se falhar, não derruba — vai para o modo de teste
    }
  }

  // Modo de teste (fallback automático)
  const fakeId = "TEST" + Date.now();
  await db.collection("pagamentos").doc(fakeId).set({
    uid: req.user.uid, valor: Number(valor), status: "pending", criadoEm: new Date(), teste: true
  });

  const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="200" fill="#f0f0f0"/>
    <text x="100" y="90" text-anchor="middle" font-size="14" fill="#333">QR de Teste</text>
    <text x="100" y="110" text-anchor="middle" font-size="11" fill="#666">Valor: R$ ${valor}</text>
  </svg>`;
  const fakeImg = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

  console.log(`🧪 Pagamento de teste criado: ${fakeId}`);
  res.json({
    id: fakeId,
    qr_img: fakeImg,
    copia_cola: `TEST${fakeId}`,
    modo: "teste"
  });
});

// ===== VERIFICAR PAGAMENTO =====
app.get("/verificar-pagamento/:id", async (req, res) => {
  const { id } = req.params;

  // Se for teste, aprova automaticamente após 10 segundos
  if (id.startsWith("TEST")) {
    const doc = await db.collection("pagamentos").doc(id).get();
    if (!doc.exists) return res.json({ status: "pending" });

    const data = doc.data();
    if (Date.now() - new Date(data.criadoEm).getTime() > 10000) {
      // Aprovar
      const userRef = db.collection("users").doc(data.uid);
      await userRef.update({
        saldo: admin.firestore.FieldValue.increment(Number(data.valor))
      });
      await db.collection("transactions").add({
        uid: data.uid, tipo: "deposito", valor: Number(data.valor), status: "aprovado", criadoEm: new Date()
      });
      await doc.ref.update({ status: "approved" });
      console.log(`✅ Teste aprovado: +R$ ${data.valor} para ${data.uid}`);
      return res.json({ status: "approved", amount: data.valor });
    }
    return res.json({ status: "pending", amount: data.valor });
  }

  // Real
  if (!payment) return res.status(500).json({ erro: "MP não configurado" });
  const pagamento = await payment.get({ id });

  if (pagamento.status === "approved") {
    const uid = pagamento.metadata?.uid;
    if (uid) {
      const userRef = db.collection("users").doc(uid);
      await userRef.update({
        saldo: admin.firestore.FieldValue.increment(Number(pagamento.transaction_amount))
      });
      await db.collection("transactions").add({
        uid, tipo: "deposito", valor: pagamento.transaction_amount, status: "aprovado", criadoEm: new Date()
      });
      console.log(`💰 Real aprovado: +R$ ${pagamento.transaction_amount}`);
    }
  }
  res.json({ status: pagamento.status, amount: pagamento.transaction_amount });
});

// Saque, Investir, IA (simplificados, com garantirDocumento)
app.post("/saque", authMiddleware, garantirDocumento, async (req, res) => {
  const { valor } = req.body;
  if (valor > req.userData.saldo) return res.status(400).json({ erro: "Saldo insuficiente" });
  await req.userRef.update({
    saldo: admin.firestore.FieldValue.increment(-Number(valor))
  });
  await db.collection("transactions").add({
    uid: req.user.uid, tipo: "saque", valor, status: "pendente", criadoEm: new Date()
  });
  res.json({ ok: true });
});

app.post("/investir", authMiddleware, garantirDocumento, async (req, res) => {
  const { tipo, valor } = req.body;
  if (valor > req.userData.saldo) return res.status(400).json({ erro: "Saldo insuficiente" });
  await req.userRef.update({
    [`investimentos.${tipo}`]: admin.firestore.FieldValue.increment(Number(valor)),
    saldo: admin.firestore.FieldValue.increment(-Number(valor))
  });
  await db.collection("transactions").add({
    uid: req.user.uid, tipo: "investimento", categoria: tipo, valor, criadoEm: new Date()
  });
  res.json({ ok: true });
});

app.post("/ia", authMiddleware, async (req, res) => {
  const { mensagem } = req.body;
  res.json({ resposta: "Você disse: " + mensagem });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
