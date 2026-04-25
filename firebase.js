const admin = require("firebase-admin");

// Tenta carregar as credenciais
let serviceAccount;

console.log("🔍 Procurando credenciais do Firebase...");

// 1. Tenta pelo arquivo local (não existe no Render, mas tenta)
try {
  serviceAccount = require("./serviceAccountKey.json");
  console.log("✅ Usando serviceAccountKey.json local");
} catch (e) {
  console.log("ℹ️ Arquivo local não encontrado, tentando variável de ambiente...");
}

// 2. Tenta pela variável de ambiente FIREBASE_SERVICE_ACCOUNT
if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Credenciais carregadas da variável FIREBASE_SERVICE_ACCOUNT");
  } catch (e) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT não é um JSON válido:", e.message);
  }
}

// 3. Se não encontrou nada, erro fatal
if (!serviceAccount) {
  console.error("❌ NENHUMA CREDENCIAL ENCONTRADA!");
  console.error("👉 No Render, vá em Environment > Environment Variables");
  console.error("👉 Adicione: FIREBASE_SERVICE_ACCOUNT = { todo o JSON da chave }");
  console.error("⚠️ O servidor vai iniciar, mas NENHUMA operação do Firestore funcionará.");
}

// Inicializa o Firebase Admin
let db, firebasePronto = false;

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("🔥 Firebase Admin inicializado com sucesso");
  firebasePronto = true;
} else {
  // Mock que gera erro descritivo
  db = {
    collection: () => {
      throw new Error("Firebase não configurado. Configure FIREBASE_SERVICE_ACCOUNT no Render.");
    }
  };
}

module.exports = { db, admin, firebasePronto };
