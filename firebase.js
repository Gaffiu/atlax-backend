const admin = require("firebase-admin");

let db;
let firebasePronto = false;

// 1. Tenta carregar a credencial
let serviceAccount = null;
try {
  serviceAccount = require("./serviceAccountKey.json");
  console.log("✅ Firebase: credencial local carregada");
} catch (e) {
  console.log("ℹ️ Firebase: arquivo local não encontrado, tentando variável de ambiente...");
}

if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Firebase: credencial da variável de ambiente carregada");
  } catch (e) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT não é um JSON válido:", e.message);
  }
}

if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  firebasePronto = true;
  console.log("🔥 Firebase Admin pronto");

  // TESTE OBRIGATÓRIO DE ESCRITA
  (async () => {
    try {
      const testRef = db.collection("teste").doc("inicializacao");
      await testRef.set({ status: "ok", timestamp: new Date() });
      const snap = await testRef.get();
      console.log("📝 Teste de escrita/leitura Firestore:", snap.data());
      await testRef.delete();
    } catch (err) {
      console.error("❌ FALHA CRÍTICA NO FIRESTORE:", err.message);
      console.error("   Verifique se a service account tem permissão de Editor no projeto.");
      firebasePronto = false;
    }
  })();
} else {
  console.error("❌ NENHUMA CREDENCIAL FIREBASE ENCONTRADA");
  db = {
    collection: () => { throw new Error("Firebase não configurado"); }
  };
}

module.exports = { db, admin, firebasePronto };
