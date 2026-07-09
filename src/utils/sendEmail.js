// src/utils/sendEmail.js
const nodemailer = require('nodemailer');

const sendEmail = async ({ email, subject, html }) => {
    
    // 🛡️ CRITICAL DEFENSE: Catch undefined/empty recipient blocks immediately before hitting SMTP envelope validation
    if (!email || typeof email !== 'string' || !email.trim()) {
        console.error("❌ [SMTP Guard] Aborted mail dispatch: Recipient email is undefined or missing.");
        throw new Error("SMTP Execution Fault: No recipient address target defined.");
    }

    // 1. Create a transporter using environment variables for generic SMTP setup
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 587, 
        secure: process.env.EMAIL_SECURE === 'true', 
        auth: {
            user: process.env.EMAIL_USERNAME, 
            pass: process.env.EMAIL_PASSWORD, 
        },
        tls: {
            rejectUnauthorized: false // Preserves handshake support for enterprise cluster environments
        }
    });

    // 2. Define mail options cleanly
    const mailOptions = {
        from: `${process.env.FROM_NAME || "IRIS Orbit"} <${process.env.EMAIL_USERNAME}>`, 
        to: email.trim().toLowerCase(), // Sanitizes the target recipient string inputs
        subject: subject || "Notification - IRIS Orbit Engine",
        html: html
    };

    // 3. Send the email wrapped inside an isolated process runner catch block
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`📬 Mail core stream safely dispatched. MessageId: ${info.messageId}`);
        return info;
    } catch (smtpError) {
        console.error("⚠️ Local SMTP Transport pipeline exception dropped:", smtpError.message);
        throw smtpError; // Rethrow to let the endpoint layer route know
    }
};

module.exports = sendEmail;