// user.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto"); // Import the crypto module

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: [true, "Please provide a username"],
        unique: true,
    },
    email: {
        type: String,
        required: [true, "Please provide an email"],
        unique: true,
        lowercase: true,
        validate: {
            validator: function(v) {
                const allowedDomain = "irisbusiness.com";
                return v.toLowerCase().endsWith(`@${allowedDomain}`);
            },
            message: props => `Email domain is not allowed. Only '@irisbusiness.com' emails can register.`,
        }
    },
    password: {
        type: String,
        required: [true, "Please provide a password"],
        minlength: 6,
        select: false,
    },
    role: {
        type: String,
        enum: ["user", "admin"],
        default: "user",
    },
    avatarUrl: {
        type: String,
        default:
            "https://res.cloudinary.com/your_cloud_name/image/upload/v1/default_avatar.png",
        required: false,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    xp: {
        type: Number,
        default: 100,
        min: 0,
    },
    // --- New fields for EMAIL VERIFICATION ---
    isVerified: { // 🚨 NEW FIELD
        type: Boolean,
        default: false,
    },
    emailVerificationToken: String, // 🚨 NEW FIELD: Hashed token for verification
    emailVerificationExpire: Date,  // 🚨 NEW FIELD: Expiration for the verification token
    // ----------------------------------------
    
    // --- Existing fields for password reset ---
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    // ------------------------------------------
});

// Add this pre-save hook to hash the password before it is saved
userSchema.pre("save", async function (next) {
    // Only hash the password if it has been modified (or is new)
    if (!this.isModified("password")) return next();

    // Generate a salt and hash the password
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Method to compare entered password with the hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

// --- Method to generate and manage the reset password token (EXISTING, CONFIRMED) ---
userSchema.methods.getResetPasswordToken = function () {
    // Generate a random token
    const resetToken = crypto.randomBytes(20).toString("hex");

    // Hash the generated token using SHA256 and store it
    this.resetPasswordToken = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

    // Set the expiration date for the token (e.g., 10 minutes from now)
    this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // Adjusted to 10 minutes for better security

    // Return the original, unhashed token to be sent to the user's email
    return resetToken;
};

// --- NEW method to generate and manage the email verification token ---
userSchema.methods.getEmailVerificationToken = function () {
    // Generate a random, unhashed token (or code)
    const verificationToken = crypto.randomBytes(32).toString("hex");

    // Hash the token using SHA256 and store the hash in the database
    this.emailVerificationToken = crypto
        .createHash("sha256")
        .update(verificationToken)
        .digest("hex");

    // Set the expiration date (e.g., 24 hours)
    this.emailVerificationExpire = Date.now() + 24 * 60 * 60 * 1000;

    // Return the original, unhashed token to be used in the verification link
    return verificationToken;
};
// ------------------------------------------------------------------------------------

module.exports = mongoose.model("User", userSchema);