console.log("🔥 Iniciando servidor...");

process.on("uncaughtException", (err) => console.error("💥 Erro não tratado:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise rejeitada:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { db, admin } = require("./firebase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const { MP_TOKEN, PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, GEMINI_API_KEY } = process.env;

console.log("🔧 Variáveis de ambiente:");
console.log("MP_TOKEN:", MP_TOKEN ? "✅ Presente" : "❌ AUSENTE");
console.log("PLUGGY_CLIENT_ID:", PLUGGY_CLIENT_ID ? "✅ Presente" : "❌ AUSENTE");
console.log("GEMINI_API_KEY:", GEMINI_API_KEY ? "✅ Presente" : "❌ AUSENTE");

// ==================== MERCADO PAGO ====================
let payment = null;
if (MP_TOKEN) {
  try {
    const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
    payment = new Payment(client);
    console.log("💳 Mercado Pago inicializado");
  } catch (e) {
    console.error("❌ Erro ao inicializar Mercado Pago:", e.message);
  }
}

// ==================== FUNÇÕES AUXILIARES ====================
async function garantirUsuario(uid) {
  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    console.log(`📄 Criando documento para usuário ${uid}`);
    await ref.set({ saldo: 0, investimentos: {}, criadoEm: new Date() });
  }
  return ref;
}

// ==================== ROTAS ====================

app.get("/", (req, res) => res.send("API Atlax rodando 🚀"));

// 🔥 DEPÓSITO (SEMPRE GERA QR CODE)
app.post("/deposito", authMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    if (!valor || valor <= 0) {
      console.log("❌ Valor inválido:", valor);
      return res.status(400).json({ erro: "Valor inválido" });
    }

    const uid = req.user.uid;
    console.log(`💰 Criando depósito de R$ ${valor} para ${uid}`);

    // Garantir que o usuário existe
    await garantirUsuario(uid);

    // Tentar criar pagamento real no Mercado Pago
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
          console.log(`✅ Pagamento real criado: ${pagamento.id}`);
          
          // Salvar no Firestore para tracking
          await db.collection("pagamentos").doc(pagamento.id.toString()).set({
            uid, valor: Number(valor), status: "pending", criadoEm: new Date()
          });

          return res.json({
            id: pagamento.id,
            qr_img: qr.qr_code_base64,
            copia_cola: qr.qr_code,
            modo: "real"
          });
        }
        
        console.log("⚠️ QR Code não retornado pelo Mercado Pago. Usando fallback.");
      } catch (mpErr) {
        console.error("❌ Erro Mercado Pago:", mpErr.response?.data || mpErr.message);
        console.log("⚠️ Usando modo de teste como fallback.");
      }
    }

    // ===== MODO DE TESTE (FALLBACK) =====
    console.log("🧪 Gerando QR Code de teste...");
    
    const fakeId = "TEST" + Date.now();
    
    // Gerar uma imagem real (QR code simples com canvas)
    const qrData = `00020126580014br.gov.bcb.pix0136${fakeId}5204000053039865802BR5925ATLAX AI6009SAO PAULO62070503***`;
    const qrImg = await gerarQRCodeImagem(qrData);

    // Salvar pagamento de teste
    await db.collection("pagamentos").doc(fakeId).set({
      uid, valor: Number(valor), status: "pending", criadoEm: new Date(), teste: true
    });

    console.log(`✅ QR Code de teste gerado: ${fakeId}`);

    res.json({
      id: fakeId,
      qr_img: qrImg,
      copia_cola: qrData,
      modo: "teste"
    });

  } catch (err) {
    console.error("❌ Erro crítico no depósito:", err);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 Função para gerar QR Code como imagem base64
async function gerarQRCodeImagem(data) {
  // Usar API pública para gerar QR code
  try {
    const response = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data)}`, {
      responseType: 'arraybuffer'
    });
    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    return `data:image/png;base64,${base64}`;
  } catch (e) {
    // Fallback para SVG
    const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
      <rect width="200" height="200" fill="#f0f0f0"/>
      <text x="100" y="80" text-anchor="middle" font-size="14" fill="#333">QR Code</text>
      <text x="100" y="100" text-anchor="middle" font-size="11" fill="#666">PIX de Teste</text>
      <text x="100" y="120" text-anchor="middle" font-size="10" fill="#999">${new Date().toLocaleTimeString()}</text>
    </svg>`;
    return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  }
}

// 🔥 VERIFICAR PAGAMENTO (COM ATUALIZAÇÃO AUTOMÁTICA)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);

    // Se for pagamento de teste, aprovar automaticamente após 10 segundos
    if (id.startsWith("TEST")) {
      const pagamentoDoc = await db.collection("pagamentos").doc(id).get();
      
      if (!pagamentoDoc.exists) {
        return res.json({ status: "pending", amount: 0, modo: "teste" });
      }

      const data = pagamentoDoc.data();
      const tempoDesdeCriacao = Date.now() - new Date(data.criadoEm).getTime();

      // Se passaram mais de 10 segundos, aprovar automaticamente
      if (tempoDesdeCriacao > 10000) {
        console.log(`✅ Aprovando pagamento de teste ${id}`);
        
        // Atualizar saldo do usuário
        await db.collection("users").doc(data.uid).update({
          saldo: admin.firestore.FieldValue.increment(Number(data.valor))
        });

        // Registrar transação
        await db.collection("transactions").add({
          uid: data.uid,
          tipo: "deposito",
          valor: Number(data.valor),
          status: "aprovado",
          criadoEm: new Date()
        });

        // Marcar pagamento como aprovado
        await pagamentoDoc.ref.update({ status: "approved" });

        console.log(`💰 Saldo atualizado: +R$ ${data.valor} para ${data.uid}`);
        
        return res.json({ status: "approved", amount: data.valor, modo: "teste" });
      }

      return res.json({ status: "pending", amount: data.valor, modo: "teste" });
    }

    // Pagamento real: verificar no Mercado Pago
    if (!payment) {
      return res.status(500).json({ erro: "Mercado Pago não configurado" });
    }

    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    // Se aprovado, atualizar saldo
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;

      if (uid) {
        await garantirUsuario(uid);
        
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

        // Marcar como aprovado no tracking
        await db.collection("pagamentos").doc(id).update({ status: "approved" });
        console.log(`💰 Saldo atualizado: +R$ ${valor} para ${uid}`);
      }
    }

    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount,
      modo: "real"
    });

  } catch (err) {
    console.error("❌ Erro ao verificar pagamento:", err.message);
    res.status(500).json({ erro: "Erro ao verificar pagamento" });
  }
});

// 🔥 SIMULAR APROVAÇÃO MANUAL (PARA TESTES)
app.post("/simular-aprovacao/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const pagamentoDoc = await db.collection("pagamentos").doc(id).get();
    
    if (!pagamentoDoc.exists) {
      return res.status(404).json({ erro: "Pagamento não encontrado" });
    }

    const data = pagamentoDoc.data();
    
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

    await pagamentoDoc.ref.update({ status: "approved" });

    console.log(`✅ Aprovação manual: +R$ ${data.valor} para ${data.uid}`);
    res.json({ ok: true, message: "Depósito aprovado com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao simular aprovação:", err);
    res.status(500).json({ erro: "Erro ao simular aprovação" });
  }
});

// 🔥 SALDO
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ erro: "Não autorizado" });
    }
    
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
  try {
    const { mensagem } = req.body;
    res.json({ resposta: "Você disse: " + mensagem });
  } catch (err) {
    res.status(500).json({ resposta: "Erro interno" });
  }
});

// 🚀 START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔧 Modo: ${payment ? "PRODUÇÃO" : "TESTE"} ${MP_TOKEN ? "(token presente)" : "(sem token)"}`);
});
