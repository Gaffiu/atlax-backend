const admin = require("firebase-admin");

let db;
let firebasePronto = false;

// 1. Carrega a credencial
let serviceAccount = null;
try {
  // Tenta carregar de um arquivo local (se existir)
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
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // Ignora campos undefined para evitar erros
    databaseURL: undefined,
    projectId: serviceAccount.project_id,
  });
  db = admin.firestore();
  firebasePronto = true;
  console.log("🔥 Firebase Admin pronto");
} else {
  console.error("❌ NENHUMA CREDENCIAL FIREBASE ENCONTRADA");
  // Mock que gera erro descritivo
  db = {
    collection: () => { throw new Error("Firebase não configurado. Configure FIREBASE_SERVICE_ACCOUNT no Render."); }
  };
}

module.exports = { db, admin, firebasePronto };
