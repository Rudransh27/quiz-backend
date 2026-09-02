// src/middleware/verifyCaptcha.js
const axios = require("axios");

// CAPTCHA verification for login/register/forgot-password (VAPT finding 7.4,
// CWE-307) — rate limiting alone still lets a slow-and-steady bot grind
// through the window; requiring a human-solved reCAPTCHA token on every
// request closes that gap without needing to lower the rate-limit thresholds.
const verifyCaptcha = async (req, res, next) => {
  const { captchaToken } = req.body;

  if (!captchaToken) {
    return res.status(400).json({ success: false, message: "CAPTCHA verification is required." });
  }

  try {
    const { data } = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      null,
      { params: { secret: process.env.RECAPTCHA_SECRET_KEY, response: captchaToken } }
    );

    if (!data.success) {
      return res.status(400).json({ success: false, message: "CAPTCHA verification failed. Please try again." });
    }

    next();
  } catch (error) {
    console.error("CAPTCHA verification error:", error.message);
    return res.status(500).json({ success: false, message: "CAPTCHA verification service unavailable. Please try again later." });
  }
};

module.exports = verifyCaptcha;
