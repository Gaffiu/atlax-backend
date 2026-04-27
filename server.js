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

// ===== ROTAS =====

app.get("/", (req, res) => res.send("API Atlax 🚀"));

// Diagnóstico do Supabase
app.get("/teste-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("usuarios").select("*").limit(1);
    if (error) throw error;
    res.json({ status: "online", data });
  } catch (e) {
    res.status(500).json({ status: "offline", erro: e.message });
  }
});

// Saldo
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
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

// Extrato
app.get("/extrato/:uid", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("uid", req.user.uid)
      .order("criado_em", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error("❌ Erro extrato:", e.message);
    res.status(500).json({ erro: "Erro ao buscar extrato" });
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

// Verificar pagamento (com atualização do saldo)
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
        // Garante que o usuário existe
        await supabase.from("usuarios").upsert({ id: uid, saldo: 0 }, { onConflict: "id" });

        // Incrementa saldo (modo seguro)
        const { data: userAtual, error: errLeitura } = await supabase
          .from("usuarios")
          .select("saldo")
          .eq("id", uid)
          .single();

        if (!errLeitura) {
          const novoSaldo = (userAtual?.saldo ?? 0) + Number(valor);
          const { error: errUpdate } = await supabase
            .from("usuarios")
            .update({ saldo: novoSaldo })
            .eq("id", uid);

          if (!errUpdate) {
            saldoAtualizado = novoSaldo;
            console.log(`💰 Saldo incrementado: ${saldoAtualizado}`);

            // Registra transação
            await supabase.from("transactions").insert({
              uid,
              tipo: "deposito",
              valor: Number(valor),
              status: "aprovado"
            });
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

// 🔥 INVESTIR (VIA FUNÇÃO RPC)
app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;

    if (!tipo || !valor || isNaN(valor) || Number(valor) <= 0) {
      return res.status(400).json({ erro: "Valor inválido" });
    }

    const { data, error } = await supabase.rpc("realizar_investimento", {
      p_uid: uid,
      p_tipo: tipo.toLowerCase().replace(/\s/g, ""),
      p_valor: Number(valor)
    });

    if (error) {
      console.error("❌ Erro RPC:", error);
      return res.status(500).json({ erro: "Erro ao processar investimento" });
    }

    if (data?.erro) {
      return res.status(400).json({ erro: data.erro });
    }

    res.json({ ok: true, novo_saldo: data.novo_saldo });
  } catch (err) {
    console.error("❌ Erro investir:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// Saque
app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    const uid = req.user.uid;

    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || valor > (user.saldo ?? 0)) return res.status(400).json({ erro: "Saldo insuficiente" });

    const novoSaldo = user.saldo - Number(valor);
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert({ uid, tipo: "saque", valor: Number(valor), status: "pendente" });

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Erro saque:", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// IA (placeholder)
app.post("/ia", authMiddleware, async (req, res) => {
  const { mensagem } = req.body;
  res.json({ resposta: "Você disse: " + mensagem });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
