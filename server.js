// 🔥 LOG INICIAL
console.log("🔥 Iniciando servidor...");

// 🔥 ERROS GLOBAIS
process.on("uncaughtException", (err) => {
  console.error("💥 Erro não tratado:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("💥 Promise rejeitada:", err);
});

// 🔥 IMPORTS
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { db, admin } = require("./firebase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const { analisarUsuario } = require("./services/ai");
const authMiddleware = require("./middleware/auth");

// 🔥 APP
const app = express();
app.use(cors());
app.use(express.json());

// 🔥 ENV
const {
  MP_TOKEN,
  PLUGGY_CLIENT_ID,
  PLUGGY_CLIENT_SECRET,
  GEMINI_API_KEY
} = process.env;

// 🔥 VALIDAÇÃO ENV
if (!MP_TOKEN) console.warn("⚠️ MP_TOKEN não definido");
if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) console.warn("⚠️ Pluggy não configurado");
if (!GEMINI_API_KEY) console.warn("⚠️ GEMINI_API_KEY não definida. IA Gemini desativada.");

// 🔥 MERCADO PAGO
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 Mercado Pago configurado");
}

// 🔥 PLUGGY
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

// ==================== ROTAS ====================

// 🔥 HEALTH
app.get("/", (req, res) => res.status(200).send("API Atlax rodando 🚀"));

// 🔥 CONNECT PLUGGY
app.get("/connect", async (req, res) => {
  try {
    if (!apiKey) await autenticarPluggy();
    if (!apiKey) return res.status(500).json({ erro: "Pluggy não autenticado" });
    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      { headers: { "X-API-KEY": apiKey } }
    );
    res.json({ accessToken: response.data.accessToken });
  } catch (e) {
    console.error("❌ Connect erro:", e.response?.data || e.message);
    res.status(500).json({ erro: "Erro ao conectar" });
  }
});

// 🔥 TRANSAÇÕES PLUGGY
app.get("/transacoes/:itemId", authMiddleware, async (req, res) => {
  try {
    if (!apiKey) await autenticarPluggy();
    if (!apiKey) return res.status(500).json({ erro: "Pluggy não autenticado" });
    const { itemId } = req.params;
    const response = await axios.get(
      `https://api.pluggy.ai/items/${itemId}/transactions`,
      { headers: { "X-API-KEY": apiKey } }
    );
    res.json(response.data);
  } catch (err) {
    console.error("❌ Erro transações:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao buscar transações" });
  }
});

// 🔥 WEBHOOK PLUGGY
app.post("/webhook/pluggy", async (req, res) => {
  try {
    console.log("📥 Webhook Pluggy recebido:", req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro webhook Pluggy:", err);
    res.sendStatus(500);
  }
});

// 🔥 CRIAR USUÁRIO
app.post("/criar-usuario", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ref = db.collection("users").doc(uid);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({
        saldo: 0,
        investimentos: {
          cdb: 0, tesouroDireto: 0, lci: 0, lca: 0, debentures: 0,
          fundosImobiliarios: 0, acoes: 0, etfs: 0, cripto: 0,
          staking: 0, rendaFixa: 0, rendaVariavel: 0,
          previdenciaPrivada: 0, fundosMultimercado: 0,
          fundosCambiais: 0, ouro: 0, dolar: 0, euro: 0,
          commodities: 0, startups: 0, crowdfunding: 0,
          nft: 0, metaverso: 0, arbitragem: 0, robosTrading: 0
        },
        rendimento: {},
        criadoEm: new Date()
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro criar usuário:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 🔥 SALDO
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ erro: "Não autorizado" });
    }
    const doc = await db.collection("users").doc(req.params.uid).get();
    if (!doc.exists) return res.json({ saldo: 0 });
    res.json({ saldo: doc.data()?.saldo ?? 0 });
  } catch (err) {
    console.error("❌ Erro saldo:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 🔥 EXTRATO
app.get("/extrato/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ erro: "Não autorizado" });
    }
    const snapshot = await db
      .collection("transactions")
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

// 🔥 DEPÓSITO
app.post("/deposito", authMiddleware, async (req, res) => {
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

    const qr = pagamento.point_of_interaction.transaction_data;
    console.log(`📊 Pagamento criado: ${pagamento.id} - Status: ${pagamento.status}`);
    
    res.json({
      id: pagamento.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code,
      status: pagamento.status
    });
  } catch (err) {
    console.error("❌ Erro MP:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 VERIFICAR STATUS DO PAGAMENTO
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);
    
    const pagamento = await payment.get({ id });
    console.log(`📊 Status do pagamento ${id}: ${pagamento.status}`);
    
    res.json({
      id: pagamento.id,
      status: pagamento.status,
      amount: pagamento.transaction_amount
    });
  } catch (err) {
    console.error("❌ Erro ao verificar pagamento:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao verificar pagamento" });
  }
});

// 🔥 WEBHOOK MP
app.post("/webhook/mp", async (req, res) => {
  try {
    console.log("📥 Webhook MP recebido:", req.body);
    const paymentId = req.body?.data?.id;
    if (!paymentId || !payment) return res.sendStatus(200);
    
    const pagamento = await payment.get({ id: paymentId });
    console.log(`📊 Webhook status: ${pagamento.status}`);
    
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      const ref = db.collection("users").doc(uid);
      
      await ref.update({
        saldo: admin.firestore.FieldValue.increment(Number(valor))
      });
      
      await db.collection("transactions").add({
        uid,
        tipo: "deposito",
        valor,
        status: "aprovado",
        criadoEm: new Date()
      });
      
      console.log("💰 Depósito aprovado via webhook:", valor);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook erro:", e);
    res.sendStatus(500);
  }
});

// 🔥 SAQUE
app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor, pix } = req.body;
    const uid = req.user.uid;
    const ref = db.collection("users").doc(uid);
    const doc = await ref.get();
    const saldo = doc.data().saldo;
    if (valor > saldo) return res.status(400).json({ erro: "Saldo insuficiente" });
    await ref.update({
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

// 🔥 INVESTIR
app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;

    const mapaTipos = {
      "Tesouro Selic": "tesouroDireto",
      "CDB": "cdb",
      "LCI": "lci",
      "LCA": "lca",
      "PETR4": "acoes",
      "VALE3": "acoes",
      "ITUB4": "acoes",
      "Bitcoin": "cripto",
      "Ethereum": "cripto",
      "Fundos Imobiliários (FIIs)": "fundosImobiliarios",
      "Staking": "staking",
    };

    const tipoBanco = mapaTipos[tipo] || tipo.toLowerCase().replace(/\s/g, "");

    const TIPOS_VALIDOS = [
      "cdb", "tesouroDireto", "lci", "lca", "debentures",
      "fundosImobiliarios", "acoes", "etfs", "cripto",
      "staking", "rendaFixa", "rendaVariavel",
      "previdenciaPrivada", "fundosMultimercado",
      "fundosCambiais", "ouro", "dolar", "euro",
      "commodities", "startups", "crowdfunding",
      "nft", "metaverso", "arbitragem", "robosTrading"
    ];

    if (!tipo || !valor || valor <= 0) {
      return res.status(400).json({ erro: "Dados inválidos" });
    }

    if (!TIPOS_VALIDOS.includes(tipoBanco)) {
      return res.status(400).json({ erro: "Tipo de investimento inválido" });
    }

    const ref = db.collection("users").doc(uid);
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const saldoAtual = doc.data().saldo || 0;
      if (valor > saldoAtual) throw new Error("Saldo insuficiente");
      t.update(ref, {
        [`investimentos.${tipoBanco}`]: admin.firestore.FieldValue.increment(Number(valor)),
        saldo: admin.firestore.FieldValue.increment(-Number(valor))
      });
    });

    await db.collection("transactions").add({
      uid,
      tipo: "investimento",
      categoria: tipoBanco,
      valor,
      criadoEm: new Date()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro investir:", err);
    res.status(400).json({ erro: err.message });
  }
});

// 🔥 IA COM GEMINI
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
        console.error("Erro na análise:", err);
        return res.json({ resposta: "Não consegui analisar sua carteira agora." });
      }
    }

    if (GEMINI_API_KEY) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
          {
            contents: [{ parts: [{ text: `Aja como um oráculo financeiro sábio e poético. Responda: ${mensagem}` }] }]
          }
        );
        const resposta = response.data.candidates[0].content.parts[0].text;
        return res.json({ resposta });
      } catch (err) {
        console.error("Erro Gemini:", err);
      }
    }

    res.json({
      resposta: "Estou refinando meus conhecimentos. Em breve darei respostas mais sábias!"
    });
  } catch (err) {
    console.error("Erro na IA:", err);
    res.status(500).json({ resposta: "Erro interno" });
  }
});

// 🚀 START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
