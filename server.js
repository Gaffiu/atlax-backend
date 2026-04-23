// 🔥 LOG INICIA
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

// 🔥 APP
const app = express();
app.use(cors());
app.use(express.json());

// 🔥 ENV
const {
  MP_TOKEN,
  PLUGGY_CLIENT_ID,
  PLUGGY_CLIENT_SECRET
} = process.env;

// 🔥 VALIDAÇÃO ENV
if (!MP_TOKEN) console.error("❌ MP_TOKEN NÃO DEFINIDO");
if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) {
  console.error("❌ PLUGGY NÃO CONFIGURADO");
}

// 🔐 AUTH MIDDLEWARE (SEM QUEBRAR FRONT)
async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!token) return next(); // 🔥 mantém compatibilidade

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;

    next();
  } catch (err) {
    console.error("❌ Auth erro:", err.message);
    return res.status(401).json({ erro: "Token inválido" });
  }
}

// 🔥 MERCADO PAGO
let payment = null;

if (MP_TOKEN) {
  const client = new MercadoPagoConfig({
    accessToken: MP_TOKEN
  });

  payment = new Payment(client);
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

// 🔥 HEALTH
app.get("/", (req, res) => {
  res.status(200).send("API Atlax rodando 🚀");
});

// 🔥 CONNECT
app.get("/connect", async (req, res) => {
  try {
    if (!apiKey) await autenticarPluggy();

    const response = await axios.post(
      "https://api.pluggy.ai/connect_token",
      {},
      {
        headers: { "X-API-KEY": apiKey }
      }
    );

    res.json({ accessToken: response.data.accessToken });

  } catch (e) {
    console.error("❌ Connect erro:", e.response?.data || e.message);
    res.status(500).json({ erro: "Erro connect" });
  }
});

// 🔥 CRIAR USUÁRIO
app.post("/criar-usuario", auth, async (req, res) => {
  try {
    const uid = req.user?.uid || req.body.uid;

    if (!uid) {
      return res.status(400).json({ erro: "UID obrigatório" });
    }

    const ref = db.collection("users").doc(uid);
    const doc = await ref.get();

    if (!doc.exists) {
      await ref.set({
        saldo: 0,

        investimentos: {
          cdb: 0,
          tesouroDireto: 0,
          lci: 0,
          lca: 0,
          debentures: 0,
          fundosImobiliarios: 0,
          acoes: 0,
          etfs: 0,
          cripto: 0,
          staking: 0,
          rendaFixa: 0,
          rendaVariavel: 0,
          previdenciaPrivada: 0,
          fundosMultimercado: 0,
          fundosCambiais: 0,
          ouro: 0,
          dolar: 0,
          euro: 0,
          commodities: 0,
          startups: 0,
          crowdfunding: 0,
          nft: 0,
          metaverso: 0,
          arbitragem: 0,
          robosTrading: 0
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
app.get("/saldo/:uid", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.uid).get();

    if (!doc.exists) return res.json({ saldo: 0 });

    res.json({ saldo: doc.data()?.saldo ?? 0 });

  } catch (err) {
    console.error("❌ Erro saldo:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 🔥 EXTRATO
app.get("/extrato/:uid", async (req, res) => {
  try {
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
app.post("/deposito", async (req, res) => {
  try {
    if (!payment) {
      return res.status(500).json({ erro: "Mercado Pago não configurado" });
    }

    const { valor, uid } = req.body;

    if (!valor || valor <= 0) {
      return res.status(400).json({ erro: "Valor inválido" });
    }

    const pagamento = await payment.create({
      body: {
        transaction_amount: Number(valor),
        payment_method_id: "pix",
        payer: { email: "cliente@atlax.com" },
        metadata: { uid }
      }
    });

    const qr = pagamento.point_of_interaction.transaction_data;

    res.json({
      id: pagamento.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code
    });

  } catch (err) {
    console.error("❌ Erro MP:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 WEBHOOK MP
app.post("/webhook/mp", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;

    if (!paymentId || !payment) return res.sendStatus(200);

    const pagamento = await payment.get({ id: paymentId });

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

      console.log("💰 Depósito aprovado:", valor);
    }

    res.sendStatus(200);

  } catch (e) {
    console.error("❌ Webhook erro:", e);
    res.sendStatus(500);
  }
});

// 🔥 SAQUE
app.post("/saque", async (req, res) => {
  try {
    const { uid, valor, pix } = req.body;

    const ref = db.collection("users").doc(uid);
    const doc = await ref.get();

    const saldo = doc.data().saldo;

    if (valor > saldo) {
      return res.status(400).json({ erro: "Saldo insuficiente" });
    }

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

// 🔥 INVESTIR (CORRIGIDO)
app.post("/investir", async (req, res) => {
  try {
    const { uid, tipo, valor } = req.body;

    const TIPOS_VALIDOS = [
      "cdb", "tesouroDireto", "lci", "lca", "debentures",
      "fundosImobiliarios", "acoes", "etfs", "cripto",
      "staking", "rendaFixa", "rendaVariavel",
      "previdenciaPrivada", "fundosMultimercado",
      "fundosCambiais", "ouro", "dolar", "euro",
      "commodities", "startups", "crowdfunding",
      "nft", "metaverso", "arbitragem", "robosTrading"
    ];

    if (!uid || !tipo || !valor || valor <= 0) {
      return res.status(400).json({ erro: "Dados inválidos" });
    }

    if (!TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ erro: "Tipo inválido" });
    }

    const ref = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);

      const saldoAtual = doc.data().saldo || 0;

      if (valor > saldoAtual) {
        throw new Error("Saldo insuficiente");
      }

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

// 🚀 START
const PORT = process.env.PORT;

if (!PORT) {
  console.error("❌ PORT não definida pelo Render");
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
