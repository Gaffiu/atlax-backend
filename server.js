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
console.log("🔧 Verificando variáveis de ambiente...");
if (!MP_TOKEN) console.warn("⚠️ MP_TOKEN não definido");
if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) console.warn("⚠️ Pluggy não configurado");
if (!GEMINI_API_KEY) console.warn("⚠️ GEMINI_API_KEY não definida. IA Gemini desativada.");

// 🔥 MERCADO PAGO
let payment = null;
if (MP_TOKEN) {
  try {
    const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
    payment = new Payment(client);
    console.log("💳 Mercado Pago configurado com sucesso");
  } catch (err) {
    console.error("❌ Erro ao configurar Mercado Pago:", err.message);
  }
} else {
  console.error("❌ MP_TOKEN não encontrado. Depósitos não funcionarão.");
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
  console.log("📥 Webhook Pluggy recebido:", req.body);
  res.sendStatus(200);
});

// 🔥 CRIAR USUÁRIO
app.post("/criar-usuario", authMiddleware, async (req, res) => {
  try {
    await garantirDocumentoUsuario(req.user.uid);
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
    
    const userRef = await garantirDocumentoUsuario(req.params.uid);
    const userDoc = await userRef.get();
    const saldo = userDoc.data()?.saldo ?? 0;
    res.json({ saldo });
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
  console.log("📥 Requisição de depósito recebida");
  
  try {
    if (!payment) {
      console.error("❌ Mercado Pago não está configurado");
      return res.status(500).json({ erro: "Mercado Pago não configurado" });
    }
    
    const { valor } = req.body;
    
    if (!valor || valor <= 0) {
      console.error("❌ Valor inválido:", valor);
      return res.status(400).json({ erro: "Valor inválido" });
    }
    
    console.log(`💰 Criando pagamento de R$ ${valor} para ${req.user.uid}`);
    
    const pagamento = await payment.create({
      body: {
        transaction_amount: Number(valor),
        payment_method_id: "pix",
        payer: { 
          email: "cliente@atlax.com",
          identification: {
            type: "CPF",
            number: "12345678909"
          }
        },
        metadata: { uid: req.user.uid }
      }
    });

    const qr = pagamento.point_of_interaction?.transaction_data;
    
    if (!qr) {
      console.error("❌ QR Code não gerado");
      return res.status(500).json({ erro: "Erro ao gerar QR Code" });
    }
    
    console.log(`✅ Pagamento criado: ${pagamento.id} - Status: ${pagamento.status}`);
    
    // Salvar no Firestore para tracking
    await db.collection("pagamentos").doc(pagamento.id.toString()).set({
      uid: req.user.uid,
      valor: Number(valor),
      status: pagamento.status,
      criadoEm: new Date()
    });
    
    res.json({
      id: pagamento.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code,
      status: pagamento.status
    });
  } catch (err) {
    console.error("❌ Erro ao criar pagamento:");
    console.error("Mensagem:", err.message);
    if (err.response?.data) {
      console.error("Detalhes:", JSON.stringify(err.response.data, null, 2));
    }
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 VERIFICAR STATUS DO PAGAMENTO (ATUALIZA SALDO AUTOMATICAMENTE)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);
    
    const pagamento = await payment.get({ id });
    console.log(`📊 Status do pagamento ${id}: ${pagamento.status}`);
    
    // Se foi aprovado, atualizar saldo IMEDIATAMENTE
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      
      console.log(`✅ Pagamento aprovado! Atualizando saldo de ${uid} em R$ ${valor}`);
      
      if (uid) {
        try {
          await garantirDocumentoUsuario(uid);
          const userRef = db.collection("users").doc(uid);
          const userDoc = await userRef.get();
          
          if (userDoc.exists) {
            const saldoAnterior = userDoc.data().saldo || 0;
            
            await userRef.update({
              saldo: admin.firestore.FieldValue.increment(Number(valor))
            });
            
            const novoSaldo = saldoAnterior + Number(valor);
            console.log(`💰 Saldo atualizado: ${saldoAnterior} -> ${novoSaldo}`);
            
            // Registrar transação
            await db.collection("transactions").add({
              uid,
              tipo: "deposito",
              valor: Number(valor),
              status: "aprovado",
              criadoEm: new Date()
            });
            
            // Atualizar status do pagamento
            await db.collection("pagamentos").doc(id.toString()).update({
              status: "approved",
              atualizadoEm: new Date()
            });
          }
        } catch (updateErr) {
          console.error("❌ Erro ao atualizar saldo:", updateErr);
        }
      }
    }
    
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

// 🔥 WEBHOOK MP (ATUALIZA SALDO AUTOMATICAMENTE)
app.post("/webhook/mp", async (req, res) => {
  try {
    console.log("📥 Webhook MP recebido:", JSON.stringify(req.body));
    const paymentId = req.body?.data?.id;
    
    if (!paymentId || !payment) {
      console.log("⚠️ Webhook sem ID ou MP não configurado");
      return res.sendStatus(200);
    }
    
    console.log(`🔍 Processando webhook para pagamento ${paymentId}`);
    const pagamento = await payment.get({ id: paymentId });
    console.log(`📊 Status via webhook: ${pagamento.status}`);
    
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      
      console.log(`✅ Webhook: Pagamento aprovado! UID: ${uid}, Valor: ${valor}`);
      
      if (uid) {
        await garantirDocumentoUsuario(uid);
        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
          const saldoAnterior = userDoc.data().saldo || 0;
          
          await userRef.update({
            saldo: admin.firestore.FieldValue.increment(Number(valor))
          });
          
          const novoSaldo = saldoAnterior + Number(valor);
          console.log(`💰 Webhook: Saldo atualizado: ${saldoAnterior} -> ${novoSaldo}`);
          
          await db.collection("transactions").add({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
            criadoEm: new Date()
          });
          
          await db.collection("pagamentos").doc(paymentId.toString()).set({
            uid,
            valor: Number(valor),
            status: "approved",
            processadoEm: new Date()
          }, { merge: true });
        }
      }
    }
    
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook erro:", e);
    res.sendStatus(500);
  }
});

// 🔥 VERIFICAR TODOS OS PAGAMENTOS PENDENTES (NOVA ROTA)
app.get("/verificar-pagamentos-pendentes/:uid", authMiddleware, async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    
    const uid = req.params.uid;
    console.log(`🔍 Verificando pagamentos pendentes para ${uid}`);
    
    const snapshot = await db.collection("pagamentos")
      .where("uid", "==", uid)
      .where("status", "==", "pending")
      .orderBy("criadoEm", "desc")
      .limit(5)
      .get();
    
    const pagamentosAtualizados = [];
    
    for (const doc of snapshot.docs) {
      const pagamentoId = doc.id;
      try {
        const pagamento = await payment.get({ id: pagamentoId });
        
        if (pagamento.status === "approved") {
          const valor = pagamento.transaction_amount;
          
          await garantirDocumentoUsuario(uid);
          await db.collection("users").doc(uid).update({
            saldo: admin.firestore.FieldValue.increment(Number(valor))
          });
          
          await db.collection("transactions").add({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
            criadoEm: new Date()
          });
          
          await doc.ref.update({ status: "approved" });
          pagamentosAtualizados.push({ id: pagamentoId, status: "approved", valor });
          console.log(`💰 Pagamento ${pagamentoId} aprovado: R$ ${valor}`);
        }
      } catch (err) {
        console.error(`Erro ao verificar ${pagamentoId}:`, err.message);
      }
    }
    
    res.json({ pagamentosAtualizados });
  } catch (err) {
    console.error("❌ Erro:", err);
    res.status(500).json({ erro: "Erro ao verificar pagamentos pendentes" });
  }
});

// 🔥 SAQUE
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

// 🔥 INVESTIR
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

// 🚀 START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
