// src/controllers/authController.js
const User = require('../models/User');
const sendEmail = require('../utils/sendEmail'); 
const crypto = require('crypto'); 
const { recordAuthEvent } = require('../services/auth/audit');
const { endUserSessions } = require('../services/auth/sessions');
const { policy } = require('../services/auth/providers');

// Accounts that sign in with Microsoft and have no IRIS Orbit password are
// never given one through "Forgot password" — unless AUTH_SSO_PASSWORD_LOGIN
// is switched on (services/auth/providers.js).
const passwordResetAllowed = (user) => !!user.password || policy.ssoAccountsMayUsePassword;

// @desc    Request password reset link
// @route   POST /api/auth/forgot-password
// @access  Public
// One identical answer whether or not the account exists (or a mail was
// already sent / failed), so this endpoint can't be used to find out which
// emails have accounts.
const FORGOT_REPLY = 'If an account with that email exists, a reset link will be sent to your inbox.';

exports.forgotPassword = async (req, res) => {
    // Plain string only — an object like {"$regex": "^a"} would otherwise be
    // used as a query operator.
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : null;

    try {
        if (!email) return res.status(200).json({ success: true, message: FORGOT_REPLY });
        const user = await User.findOne({ email }).select('+password');

        if (!user) {
            return res.status(200).json({ success: true, message: FORGOT_REPLY });
        }
        if (!passwordResetAllowed(user)) {
            await recordAuthEvent({ type: 'PASSWORD_RESET_REQUESTED', req, userId: user._id, email, provider: 'local', success: false, reason: 'sso_only' });
            return res.status(200).json({ success: true, message: FORGOT_REPLY });
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
            return res.status(200).json({ success: true, message: FORGOT_REPLY });
        }

        const resetToken = user.getResetPasswordToken();
        await recordAuthEvent({ type: 'PASSWORD_RESET_REQUESTED', req, userId: user._id, email, provider: 'local', success: true });
        await user.save({ validateBeforeSave: false }); 

        // Link to the frontend (CLIENT_URL, first entry if comma-separated) —
        // never the request's Host header, which a caller can forge to get a
        // victim's reset token mailed to a link on their own domain.
        const clientUrl = (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
        const resetUrl = `${clientUrl}/reset-password/${resetToken}`;

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
                email: user.email, // sendEmail() reads `email`, not `to`
                subject: 'Password Reset Request - IRIS Orbit',
                text: `You have requested to reset your password. Please visit ${resetUrl} to do so. This link is valid for 10 minutes.`, 
                html: message, 
            });

            res.status(200).json({ success: true, message: FORGOT_REPLY });
        } catch (error) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save({ validateBeforeSave: false });

            // Logged for ops; the caller gets the same answer as every other
            // path (a distinct error would reveal that the account exists).
            console.error('Email sending error:', error);
            return res.status(200).json({ success: true, message: FORGOT_REPLY });
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

    try {
        if (typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ success: false, message: 'Your new password must be at least 6 characters.' });
        }
        const hashedToken = crypto.createHash('sha256').update(String(token || '')).digest('hex');
        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { $gt: Date.now() },
        }).select('+password');

        if (!user || !passwordResetAllowed(user)) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
        }

        user.password = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        // A reset is a fresh start: no lockout carried over.
        user.failedLoginAttempts = 0;
        user.lockUntil = null;

        await user.save();

        // End every live session server-side (old tokens are also refused
        // via passwordChangedAt). An SSO link stays as it is, so Microsoft
        // sign-in keeps working.
        await endUserSessions(user._id, 'password_reset', { req });
        await recordAuthEvent({ type: 'PASSWORD_RESET', req, userId: user._id, email: user.email, provider: 'local', success: true });

        res.status(200).json({ success: true, message: 'Password successfully reset. You can now log in.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};