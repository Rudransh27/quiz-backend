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
    match: [/.+@.+\..+/, "Please enter a valid email address"],
  },
  password: {
    type: String,
    required: [true, "Please provide a password"],
    minlength: 6,
    select: false, // This ensures the password is not returned by default in queries
  },
  role: {
    type: String,
    enum: ["user", "admin"],
    default: "user", // By default, new users are regular users
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
    default: 100, // starting XP
    min: 0, // prevent negatives
  },
  // --- New fields for password reset ---
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  // -----------------------------------
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

// --- New method to generate and manage the reset password token ---
userSchema.methods.getResetPasswordToken = function () {
  // Generate a random token
  const resetToken = crypto.randomBytes(20).toString("hex");

  // Hash the generated token using SHA256 and store it
  this.resetPasswordToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  // Set the expiration date for the token (e.g., 10 minutes from now)
  this.resetPasswordExpire = Date.now() + 2 * 60 * 1000; //  minutes in milliseconds

  // Return the original, unhashed token to be sent to the user's email
  return resetToken;
};
// ----------------------------------------------------------------

module.exports = mongoose.model("User", userSchema);
