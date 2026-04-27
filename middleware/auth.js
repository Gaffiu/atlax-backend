const admin = require("firebase-admin");

// Inicializa o Firebase Admin se ainda não foi inicializado
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : undefined;

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    // Fallback para aplicações que já inicializaram de outra forma
    admin.initializeApp();
  }
}

async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!token) {
      return res.status(401).json({ erro: "Token não enviado" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Auth erro:", err);
    res.status(401).json({ erro: "Token inválido" });
  }
}

module.exports = authMiddleware;
