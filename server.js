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

const { MP_TOKEN, PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, GEMINI_API_KEY } = process.env;

if (!MP_TOKEN) console.warn("⚠️ MP_TOKEN não definido");
if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) console.warn("⚠️ Pluggy não configurado");

let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 Mercado Pago configurado");
}

let apiKey = null;
async function autenticarPluggy() {
  try {
    const res = await axios.post("https://api.pluggy.ai/auth", {
      clientId: PLUGGY_CLIENT_ID,
      clientSecret: PLUGGY_CLIENT_SECRET
    });
    apiKey = res.data.apiKey;
    console.log("🔑 Pluggy autenticado");
  } catch (err) {
    console.error("❌ Erro Pluggy:", err.response?.data || err.message);
  }
}

// ==================== FUNÇÃO AUXILIAR ====================
async function garantirDocumentoUsuario(uid) {
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  
  if (!userDoc.exists) {
    console.log(`📄 Criando documento para usuário ${uid}`);
    await userRef.set({
      saldo: 0,
      investimentos: {},
      criadoEm: new Date()
    });
  }
  return userRef;
}

// ==================== ROTAS ====================

app.get("/", (req, res) => res.status(200).send("API Atlax rodando 🚀"));

app.get("/connect", async (req, res) => {
  try {
    if (!apiKey) await autenticarPluggy();
    if (!apiKey) return res.status(500).json({ erro: "Pluggy não autenticado" });
    const response = await axios.post("https://api.pluggy.ai/connect_token", {}, {
      headers: { "X-API-KEY": apiKey }
    });
    res.json({ accessToken: response.data.accessToken });
  } catch (e) {
    console.error("❌ Connect erro:", e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao conectar" });
  }
});

app.get("/transacoes/:itemId", authMiddleware, async (req, res) => {
  try {
    if (!apiKey) await autenticarPluggy();
    if (!apiKey) return res.status(500).json({ erro: "Pluggy não autenticado" });
    const response = await axios.get(`https://api.pluggy.ai/items/${req.params.itemId}/transactions`, {
      headers: { "X-API-KEY": apiKey }
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Erro transações:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao buscar transações" });
  }
});

app.post("/webhook/pluggy", async (req, res) => {
  console.log("📥 Webhook Pluggy recebido:", req.body);
  res.sendStatus(200);
});

app.post("/criar-usuario", authMiddleware, async (req, res) => {
  try {
    await garantirDocumentoUsuario(req.user.uid);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro criar usuário:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ erro: "Não autorizado" });
    }
    
    const userRef = await garantirDocumentoUsuario(req.params.uid);
    const userDoc = await userRef.get();
    const saldo = userDoc.data()?.saldo ?? 0;
    res.json({ saldo });
  } catch (err) {
    console.error("❌ Erro saldo:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

app.get("/extrato/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ erro: "Não autorizado" });
    }
    const snapshot = await db.collection("transactions")
      .where("uid", "==", req.params.uid)
      .orderBy("criadoEm", "desc")
      .get();
    const lista = snapshot.docs.map(doc => doc.data());
    res.json(lista);
  } catch (err) {
    console.error("❌ Extrato erro:", err);
    res.status(500).json({ erro: "Erro ao buscar extrato" });
  }
});

app.post("/deposito", authMiddleware, async (req, res) => {
  console.log("📥 Requisição de depósito recebida");
  
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    
    const { valor } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });
    
    console.log(`💰 Criando pagamento de R$ ${valor} para ${req.user.uid}`);
    
    const pagamento = await payment.create({
      body: {
        transaction_amount: Number(valor),
        payment_method_id: "pix",
        payer: { email: "cliente@atlax.com" },
        metadata: { uid: req.user.uid }
      }
    });

    const qr = pagamento.point_of_interaction?.transaction_data;
    if (!qr) {
      console.error("❌ QR Code não gerado");
      return res.status(500).json({ erro: "Erro ao gerar QR Code" });
    }
    
    console.log(`✅ Pagamento criado: ${pagamento.id} - Status: ${pagamento.status}`);
    
    res.json({
      id: pagamento.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code,
      status: pagamento.status
    });
  } catch (err) {
    console.error("❌ Erro ao criar pagamento:", err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);
    
    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);
    
    // Se aprovado, atualizar saldo automaticamente
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      
      if (uid) {
        console.log(`💰 Atualizando saldo de ${uid}: +R$ ${valor}`);
        
        await garantirDocumentoUsuario(uid);
        const userRef = db.collection("users").doc(uid);
        
        await userRef.update({
          saldo: admin.firestore.FieldValue.increment(Number(valor))
        });
        
        await db.collection("transactions").add({
          uid,
          tipo: "deposito",
          valor: Number(valor),
          status: "aprovado",
          criadoEm: new Date()
        });
        
        console.log(`✅ Saldo atualizado com sucesso`);
      }
    }
    
    res.json({
      id: pagamento.id,
      status: pagamento.status,
      amount: pagamento.transaction_amount
    });
  } catch (err) {
    console.error("❌ Erro ao verificar:", err.message);
    res.status(500).json({ erro: "Erro ao verificar pagamento" });
  }
});

app.post("/webhook/mp", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId || !payment) return res.sendStatus(200);
    
    const pagamento = await payment.get({ id: paymentId });
    console.log(`📥 Webhook: ${pagamento.status}`);
    
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      
      if (uid) {
        await garantirDocumentoUsuario(uid);
        const userRef = db.collection("users").doc(uid);
        
        await userRef.update({
          saldo: admin.firestore.FieldValue.increment(Number(valor))
        });
        
        await db.collection("transactions").add({
          uid,
          tipo: "deposito",
          valor: Number(valor),
          status: "aprovado",
          criadoEm: new Date()
        });
        
        console.log(`💰 Webhook: Saldo atualizado para ${uid}`);
      }
    }
    
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook erro:", e);
    res.sendStatus(500);
  }
});

app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor, pix } = req.body;
    const uid = req.user.uid;
    
    const userRef = await garantirDocumentoUsuario(uid);
    const userDoc = await userRef.get();
    const saldo = userDoc.data().saldo || 0;
    
    if (valor > saldo) return res.status(400).json({ erro: "Saldo insuficiente" });
    
    await userRef.update({
      saldo: admin.firestore.FieldValue.increment(-Number(valor))
    });
    
    await db.collection("transactions").add({
      uid,
      tipo: "saque",
      valor,
      status: "pendente",
      criadoEm: new Date()
    });
    
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro saque:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;

    const ref = await garantirDocumentoUsuario(uid);
    
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const saldoAtual = doc.data().saldo || 0;
      if (valor > saldoAtual) throw new Error("Saldo insuficiente");
      t.update(ref, {
        [`investimentos.${tipo}`]: admin.firestore.FieldValue.increment(Number(valor)),
        saldo: admin.firestore.FieldValue.increment(-Number(valor))
      });
    });

    await db.collection("transactions").add({
      uid,
      tipo: "investimento",
      categoria: tipo,
      valor,
      criadoEm: new Date()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro investir:", err);
    res.status(400).json({ erro: err.message });
  }
});

app.post("/ia", authMiddleware, async (req, res) => {
  try {
    const { mensagem } = req.body;
    const uid = req.user?.uid;

    if (mensagem && (mensagem.toLowerCase().includes("analise") || mensagem.toLowerCase().includes("carteira"))) {
      if (!uid) return res.json({ resposta: "Faça login para analisar sua carteira." });
      try {
        const analise = await analisarUsuario(uid);
        return res.json({ resposta: analise });
      } catch (err) {
        return res.json({ resposta: "Não consegui analisar sua carteira agora." });
      }
    }

    if (GEMINI_API_KEY) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
          { contents: [{ parts: [{ text: `Aja como um oráculo financeiro sábio e poético. Responda: ${mensagem}` }] }] }
        );
        return res.json({ resposta: response.data.candidates[0].content.parts[0].text });
      } catch (err) {}
    }

    res.json({ resposta: "Você disse: " + mensagem });
  } catch (err) {
    res.status(500).json({ resposta: "Erro interno" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
