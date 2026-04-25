console.log("🔥 Iniciando servidor...");

process.on("uncaughtException", (err) => console.error("💥 Erro não tratado:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise rejeitada:", err));

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

const { MP_TOKEN, PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET } = process.env;

console.log("MP_TOKEN:", MP_TOKEN ? "✅" : "❌");
console.log("PLUGGY_CLIENT_ID:", PLUGGY_CLIENT_ID ? "✅" : "❌");

let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 Mercado Pago configurado");
}

// Função que cria o usuário SE NÃO EXISTIR
async function garantirUsuario(uid) {
  if (!firebasePronto) {
    console.error("❌ Firebase não configurado. Não foi possível garantir usuário.");
    return null;
  }
  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    console.log(`📄 Criando documento para ${uid}`);
    await ref.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
  }
  return ref;
}

// ===== ROTAS =====

app.get("/", (req, res) => res.send("API Atlax rodando 🚀"));

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  if (req.user.uid !== req.params.uid) return res.status(403).json({ erro: "Não autorizado" });
  if (!firebasePronto) return res.status(500).json({ erro: "Firebase não configurado" });
  const ref = await garantirUsuario(req.params.uid);
  if (!ref) return res.status(500).json({ erro: "Erro ao acessar usuário" });
  const doc = await ref.get();
  res.json({ saldo: doc.data()?.saldo ?? 0 });
});

// 🔥 DEPÓSITO (ORIGINAL, SEM ALTERAÇÕES NO QR)
app.post("/deposito", authMiddleware, async (req, res) => {
  console.log("📥 Depósito recebido");
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
    
    console.log(`✅ Pagamento criado: ${pagamento.id}`);
    
    // Tenta salvar no Firestore, mas não quebra se falhar
    if (firebasePronto) {
      try {
        await db.collection("pagamentos").doc(pagamento.id.toString()).set({
          uid: req.user.uid,
          valor: Number(valor),
          status: "pending",
          criadoEm: new Date()
        });
      } catch (dbErr) {
        console.error("⚠️ Não salvou no Firestore, mas QR foi gerado:", dbErr.message);
      }
    }
    
    res.json({
      id: pagamento.id,
      qr_img: qr.qr_code_base64,
      copia_cola: qr.qr_code,
      status: "pending"
    });
  } catch (err) {
    console.error("❌ Erro ao criar pagamento:", err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 VERIFICAR PAGAMENTO
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Mercado Pago não configurado" });
    const { id } = req.params;
    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);
    
    if (pagamento.status === "approved" && firebasePronto) {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      
      if (uid) {
        const ref = await garantirUsuario(uid);
        if (ref) {
          await ref.update({
            saldo: admin.firestore.FieldValue.increment(Number(valor))
          });
          await db.collection("transactions").add({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
            criadoEm: new Date()
          });
          console.log(`💰 Saldo atualizado: +R$ ${valor}`);
        }
      }
    }
    
    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount
    });
  } catch (err) {
    console.error("❌ Erro ao verificar:", err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
