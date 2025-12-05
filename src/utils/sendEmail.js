// src/utils/sendEmail.js

const nodemailer = require('nodemailer');

const sendEmail = async ({email, subject, html}) => {
    
    // 1. Create a transporter using environment variables for generic SMTP setup
    const transporter = nodemailer.createTransport({
        // Using host, port, and secure flag for flexibility beyond 'gmail'
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT, // Often 587 (TLS) or 465 (SSL)
        secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.EMAIL_USERNAME, 
            pass: process.env.EMAIL_PASSWORD, // Must be an App Password if using Gmail/Outlook
        },
        // Allows self-signed certificates, useful for some local/testing environments.
        // Should be set to false in strict production environments if possible.
        tls: {
            rejectUnauthorized: false
        }
    });

    // 2. Define mail options
    const mailOptions = {
        // Use environment variables for sender name/email for flexibility
        from: `${process.env.FROM_NAME || "Your App Name"} <${process.env.EMAIL_USERNAME}>`, 
        to: email,
        subject: subject,
        html: html
    };

    // 3. Send the email
    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;