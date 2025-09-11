// src/utils/sendEmail.js

const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
    // 1. Create a transporter using your email service credentials
    //    IMPORTANT: Use environment variables for sensitive data (email/password)
    const transporter = nodemailer.createTransport({
        // Example using Gmail. For production, consider services like SendGrid, Mailgun, or AWS SES.
        service: 'gmail', 
        auth: {
            user: process.env.EMAIL_USERNAME, // Your email address
            pass: process.env.EMAIL_PASSWORD, // Your email password or app-specific password
        },
    });

    // 2. Define mail options
    const mailOptions = {
        from: `"Your App Name" <${process.env.EMAIL_USERNAME}>`, // Sender address
        to: options.to, // List of receivers
        subject: options.subject, // Subject line
        html: options.html, // HTML body content
        text: options.text, // Plain text body content (fallback for clients that don't support HTML)
    };

    // 3. Send the email
    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;