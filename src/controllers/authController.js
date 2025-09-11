// src/controllers/authController.js
const User = require('../models/User');
const sendEmail = require('../utils/sendEmail'); // Path to your email utility
const crypto = require('crypto'); // For hashing tokens

// --- Existing Login/Register Controllers (ensure they are present) ---
// exports.register = async (req, res) => { ... };
// exports.login = async (req, res) => { ... };
// ---

// @desc    Request password reset link
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        // 1. Find the user by email
        const user = await User.findOne({ email });

        if (!user) {
            // Important: Don't reveal if the email exists or not to prevent enumeration attacks.
            // Send a generic success message even if the email is not found.
            return res.status(400).json({ success: false, message: 'If an account with that email exists, a reset link will be sent.' });
        }

        // 2. Generate and save the reset token
        const resetToken = user.getResetPasswordToken(); // This method is defined in User.js
        await user.save({ validateBeforeSave: false }); // Save the updated user document

        // 3. Create the reset URL
        //    Make sure to use your actual frontend domain for the link.
        //    'req.protocol' (http/https), 'req.get('host')' (your domain), '/reset-password/:token' (frontend route)
        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${resetToken}`;

        const message = `
            <h2>Password Reset Request</h2>
            <p>You have requested to reset your password. Please click on the link below to proceed:</p>
            <p><a href="${resetUrl}" style="color: #007bff; text-decoration: none;">${resetUrl}</a></p>
            <p>This link will expire in 10 minutes. If you did not request this, please ignore this email.</p>
            <br>
            <p>Sincerely,</p>
            <p>Your App Team</p>
        `;

        // 4. Send the email
        try {
            await sendEmail({
                to: user.email,
                subject: 'Password Reset Request',
                text: `You have requested to reset your password. Please visit ${resetUrl} to do so. This link is valid for 10 minutes.`, // Plain text fallback
                html: message, // HTML content for richer formatting
            });

            res.status(200).json({ success: true, message: 'Password reset email sent. Please check your inbox.' });
        } catch (error) {
            // If email fails, clean up the token from the user document
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
    const { token } = req.params; // The token from the URL

    // 1. Hash the incoming token to match the one stored in the database
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    try {
        // 2. Find the user by the hashed token and check if the token has expired
        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { $gt: Date.now() }, // $gt means "greater than"
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
        }

        // 3. Set the new password and clear the reset fields
        //    The 'save' hook in the User model will automatically hash the new password.
        user.password = password; // Assign the new password
        user.resetPasswordToken = undefined; // Clear the token
        user.resetPasswordExpire = undefined; // Clear the expiration date

        await user.save(); // Save the updated user

        // 4. Optionally, you could automatically log the user in here by generating a new JWT,
        //    but for simplicity, we'll just let them know it's done and redirect to login.

        res.status(200).json({ success: true, message: 'Password successfully reset.' });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};