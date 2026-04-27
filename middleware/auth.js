const axios = require("axios");

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split("Bearer ")[1];

  if (!token) {
    return res.status(401).json({ erro: "Token não enviado" });
  }

  try {
    // 🔥 API REST do Firebase Auth – gratuita e sem SDK Admin
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyBoKjxuXPavGouobfLmDkI2Po6K5kBkulc`,
      { idToken: token }
    );

    const user = response.data.users?.[0];
    if (!user) {
      return res.status(401).json({ erro: "Token inválido" });
    }

    // Injeta o uid no req.user, exatamente como antes
    req.user = { uid: user.localId };
    next();
  } catch (err) {
    console.error("❌ Auth erro:", err.response?.data || err.message);
    res.status(401).json({ erro: "Token inválido" });
  }
}

module.exports = authMiddleware;
