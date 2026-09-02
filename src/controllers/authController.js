// src/controllers/authController.js
const User = require('../models/User');
const sendEmail = require('../utils/sendEmail'); 
const crypto = require('crypto'); 

// @desc    Request password reset link
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(200).json({
                success: true,
                message: 'If an account with that email exists, a reset link will be sent to your inbox.'
            });
        }

        // 🔒 Per-account cooldown — the forgotPasswordLimiter (rateLimiters.js)
        // caps this per IP, but an attacker spread across IPs (or just not
        // trying to evade detection) could still mail-bomb one victim's inbox
        // from many sources. getResetPasswordToken() sets a fresh 10-minute
        // expiry every call, so "more than 9 minutes still remaining" means a
        // reset email was already sent within roughly the last minute —
        // reusing that field instead of adding new schema/state to track it.
        const RESET_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
        const COOLDOWN_MS = 60 * 1000;
        if (user.resetPasswordExpire && user.resetPasswordExpire.getTime() - Date.now() > RESET_TOKEN_LIFETIME_MS - COOLDOWN_MS) {
            return res.status(200).json({
                success: true,
                message: 'If an account with that email exists, a reset link will be sent to your inbox.',
            });
        }

        const resetToken = user.getResetPasswordToken();
        await user.save({ validateBeforeSave: false }); 

        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${resetToken}`;

        const message = `
            <h3>IRIS Orbit Platform - Password Reset Request</h3>
            <p>Hi,</p>
            <p>You have requested to reset your password. Please click on the link below to proceed:</p>
            <p><a href="${resetUrl}" style="color: #0d6efd; text-decoration: none; font-weight: bold;">${resetUrl}</a></p>
            <p>This link will expire in 10 minutes. If you did not request this, please safely ignore this email.</p>
            <br>
            <p>Sincerely,</p>
            <p><strong>IRIS Orbit Team</strong></p>
        `;

        try {
            await sendEmail({
                to: user.email,
                subject: 'Password Reset Request - IRIS Orbit',
                text: `You have requested to reset your password. Please visit ${resetUrl} to do so. This link is valid for 10 minutes.`, 
                html: message, 
            });

            res.status(200).json({ success: true, message: 'Password reset email sent. Please check your inbox.' });
        } catch (error) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save({ validateBeforeSave: false });

            console.error('Email sending error:', error);
            return res.status(500).json({ success: false, message: 'Failed to send email. Please try again later.' });
        }

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Reset user password
// @route   PUT /api/auth/reset-password/:token
// @access  Public
exports.resetPassword = async (req, res) => {
    const { password } = req.body;
    const { token } = req.params; 

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    try {
        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { $gt: Date.now() }, 
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
        }

        user.password = password; 
        user.resetPasswordToken = undefined; 
        user.resetPasswordExpire = undefined; 

        await user.save(); 

        res.status(200).json({ success: true, message: 'Password successfully reset. You can now log in.' });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};