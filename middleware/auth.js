const { admin } = require("../firebase");

async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!token) {
      return res.status(401).json({ erro: "Token não enviado" });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    req.user = decoded; // 🔥 aqui vem o UID seguro

    next();
  } catch (err) {
    console.error("❌ Auth erro:", err);
    res.status(401).json({ erro: "Token inválido" });
  }
}

module.exports = authMiddleware;
