console.log("🔥 Iniciando servidor...");
process.on("uncaughtException", (err) => console.error("💥 Erro:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const supabase = require("./supabase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

console.log("📌 Supabase:", process.env.SUPABASE_URL ? "configurado" : "NÃO configurado");

const { MP_TOKEN } = process.env;
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

// ========== FUNÇÃO AUXILIAR (CRIA USUÁRIO SE NÃO EXISTIR) ==========
async function garantirUsuario(uid) {
  const { data: existe } = await supabase
    .from("usuarios")
    .select("id")
    .eq("id", uid)
    .single();

  if (!existe) {
    console.log(`📄 Criando usuário ${uid} no Supabase`);
    await supabase.from("usuarios").insert({ id: uid, saldo: 0 });
  }
}

// ========== ROTAS ==========

app.get("/", (req, res) => res.send("API Atlax 🚀"));

app.get("/teste-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("usuarios").select("*").limit(1);
    if (error) throw error;
    res.json({ status: "online", data });
  } catch (e) {
    res.status(500).json({ status: "offline", erro: e.message });
  }
});

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    await garantirUsuario(req.user.uid);
    const { data, error } = await supabase
      .from("usuarios")
      .select("saldo")
      .eq("id", req.user.uid)
      .single();

    if (error) throw error;
    const saldo = data?.saldo ?? 0;
    console.log(`📊 Saldo de ${req.user.uid}: ${saldo}`);
    res.json({ saldo });
  } catch (e) {
    console.error("❌ Erro saldo:", e.message);
    res.status(500).json({ erro: "Erro ao buscar saldo" });
  }
});

// Depósito (QR Code original)
app.post("/deposito", authMiddleware, async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const { valor } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });

    const pagamento = await payment.create({
      body: {
        transaction_amount: Number(valor),
        payment_method_id: "pix",
        payer: { email: "cliente@atlax.com" },
        metadata: { uid: req.user.uid }
      }
    });
    const qr = pagamento.point_of_interaction?.transaction_data;
    if (!qr) return res.status(500).json({ erro: "QR não gerado" });

    console.log(`✅ Pagamento criado: ${pagamento.id}`);
    res.json({ id: pagamento.id, qr_img: qr.qr_code_base64, copia_cola: qr.qr_code });
  } catch (err) {
    console.error("❌ Erro depósito:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 VERIFICAR PAGAMENTO (COM LEITURA GARANTIDA DO SALDO)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);
    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    let saldoAtualizado = null;

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      console.log(`✅ Aprovado! UID: ${uid}, Valor: R$ ${valor}`);

      if (uid) {
        await garantirUsuario(uid);

        // 🔁 Buscar saldo atual, somar e atualizar (mais seguro que raw)
        const { data: userAtual, error: errLeitura } = await supabase
          .from("usuarios")
          .select("saldo")
          .eq("id", uid)
          .single();

        if (errLeitura) {
          console.error("❌ Erro ao ler saldo:", errLeitura.message);
        } else {
          const novoSaldo = (userAtual?.saldo ?? 0) + Number(valor);
          const { error: errUpdate } = await supabase
            .from("usuarios")
            .update({ saldo: novoSaldo })
            .eq("id", uid);

          if (errUpdate) {
            console.error("❌ Erro ao atualizar saldo:", errUpdate.message);
          } else {
            console.log(`💰 Saldo incrementado para ${novoSaldo}`);

            // Registra transação
            await supabase.from("transactions").insert({
              uid,
              tipo: "deposito",
              valor: Number(valor),
              status: "aprovado"
            });

            saldoAtualizado = novoSaldo;
          }
        }
      }
    }

    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount,
      saldo: saldoAtualizado
    });
  } catch (err) {
    console.error("❌ Erro verificar:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

// Saque
app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    const uid = req.user.uid;
    await garantirUsuario(uid);

    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (valor > (user?.saldo ?? 0)) return res.status(400).json({ erro: "Saldo insuficiente" });

    const novoSaldo = user.saldo - Number(valor);
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert({ uid, tipo: "saque", valor: Number(valor), status: "pendente" });

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Erro saque:", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// Investir
app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;
    await garantirUsuario(uid);

    const { data: user } = await supabase.from("usuarios").select("saldo, investimentos").eq("id", uid).single();
    if (valor > (user?.saldo ?? 0)) return res.status(400).json({ erro: "Saldo insuficiente" });

    const investimentosAtuais = user?.investimentos || {};
    investimentosAtuais[tipo] = (investimentosAtuais[tipo] || 0) + Number(valor);

    const novoSaldo = user.saldo - Number(valor);
    await supabase.from("usuarios").update({
      saldo: novoSaldo,
      investimentos: investimentosAtuais
    }).eq("id", uid);

    await supabase.from("transactions").insert({ uid, tipo: "investimento", valor: Number(valor) });

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Erro investir:", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// IA (mantida igual)
app.post("/ia", authMiddleware, async (req, res) => {
  const { mensagem } = req.body;
  res.json({ resposta: "Você disse: " + mensagem });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
