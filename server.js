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

// Função que garante que o documento do usuário existe
async function garantirDocumentoUsuario(uid) {
  if (!firebasePronto) throw new Error("Firebase não configurado");
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    console.log(`📄 Criando documento para ${uid}`);
    await userRef.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
  } else {
    console.log(`📄 Documento já existe para ${uid}`);
  }
  return userRef;
}

// Função para gerar imagem QR a partir do código PIX (fallback)
async function gerarQRCodeImagem(codigoPix) {
  try {
    const response = await axios.get(
      `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(codigoPix)}`,
      { responseType: "arraybuffer" }
    );
    const base64 = Buffer.from(response.data, "binary").toString("base64");
    return `data:image/png;base64,${base64}`;
  } catch (e) {
    console.error("Erro ao gerar QR externo:", e.message);
    return null;
  }
}

// ==================== ROTAS ====================

app.get("/", (req, res) => res.send("API Atlax ativa 🚀"));

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ erro: "Não autorizado" });
    if (!firebasePronto) return res.status(500).json({ erro: "Firebase offline" });
    const userRef = await garantirDocumentoUsuario(req.params.uid);
    const userDoc = await userRef.get();
    const saldo = userDoc.data()?.saldo ?? 0;
    console.log(`📊 Saldo consultado para ${req.params.uid}: ${saldo}`);
    res.json({ saldo });
  } catch (err) {
    console.error("❌ Erro saldo:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 🔥 DEPÓSITO
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

    console.log("🔍 Resposta do MP:", JSON.stringify(pagamento).slice(0, 200));

    const qr = pagamento.point_of_interaction?.transaction_data;
    let qr_img = qr?.qr_code_base64;
    const copia_cola = qr?.qr_code;

    // Fallback: se não veio base64, gera imagem a partir do copia_cola
    if (!qr_img && copia_cola) {
      console.log("⚠️ QR base64 ausente, gerando imagem via API externa...");
      qr_img = await gerarQRCodeImagem(copia_cola);
    }

    if (!qr_img || !copia_cola) {
      console.error("❌ Não foi possível obter QR Code");
      return res.status(500).json({ erro: "Erro ao gerar QR Code" });
    }

    console.log(`✅ Pagamento criado: ${pagamento.id}`);

    // Salvar tracking (não essencial)
    try {
      await db.collection("pagamentos").doc(pagamento.id.toString()).set({
        uid: req.user.uid,
        valor: Number(valor),
        status: "pending",
        criadoEm: new Date()
      });
    } catch (dbErr) {
      console.error("⚠️ Erro ao salvar tracking:", dbErr.message);
    }

    res.json({
      id: pagamento.id,
      qr_img,
      copia_cola,
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
    console.log(`🔍 Verificando pagamento ${id}...`);

    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      console.log(`✅ Aprovado! UID: ${uid}, Valor: ${valor}`);

      if (uid && firebasePronto) {
        try {
          const userRef = await garantirDocumentoUsuario(uid);
          await userRef.update({
            saldo: admin.firestore.FieldValue.increment(Number(valor))
          });
          console.log(`💰 Saldo atualizado no Firestore`);

          await db.collection("transactions").add({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
            criadoEm: new Date()
          });
          console.log(`📝 Transação registrada`);
        } catch (updateErr) {
          console.error("❌ Erro ao atualizar saldo no Firestore:", updateErr);
        }
      } else {
        console.error("❌ Firebase offline ou UID ausente");
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

// Webhook, saque, investir, IA mantidos (não afetam o problema)
// ...

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
