// Authentication Middleware - Factor 15: Authentication & Authorization
// Validates Firebase tokens or allows bypass in development

const logger = require("../utils/logger");

// In production, this should validate Firebase ID tokens
// For development/testing, we can allow bypass

const authMiddleware = async (req, res, next) => {
  try {
    // Get authorization header
    const authHeader = req.headers.authorization;

    // If no auth and not in dev mode, reject
    if (!authHeader && process.env.ENVIRONMENT === "production") {
      return res.status(401).json({ error: "Authentication required" });
    }

    // In development, allow requests without auth
    if (process.env.ENVIRONMENT !== "production") {
      req.user = { uid: req.query.userId || "dev-user" };
      return next();
    }

    // Extract token
    const token = authHeader.replace("Bearer ", "");

    // TODO: Implement Firebase Admin SDK validation
    // const admin = require('firebase-admin');
    // const decodedToken = await admin.auth().verifyIdToken(token);
    // req.user = decodedToken;

    // For now, basic validation
    if (!token) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Mock user for demo (replace with actual Firebase validation)
    req.user = { uid: "authenticated-user" };

    next();
  } catch (error) {
    logger.error("Authentication error:", error);
    res.status(401).json({ error: "Authentication failed" });
  }
};

module.exports = authMiddleware;
