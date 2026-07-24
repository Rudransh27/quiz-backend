// createVaptTestUser.js
// Creates (or removes) one dedicated, clearly-labeled account for handing to
// an external/internal VAPT team — never reuse a real employee's login for
// this. Goes through the real User model (so the pre-save bcrypt hook hashes
// the password exactly like a normal signup would) and sets isVerified:true
// directly, skipping the OTP email step since nobody should be reading a
// shared test account's inbox.
//
// USAGE
//
//   Create (defaults to role "user", department "carbon"):
//     node createVaptTestUser.js
//
//   Custom email/department/role:
//     node createVaptTestUser.js --email=vapt.test@irisregtech.com --dept=carbon --role=user
//
//   Remove it after the engagement is done:
//     node createVaptTestUser.js --delete --email=vapt.test@irisregtech.com
//
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("./src/models/User");
const Department = require("./src/models/Department");

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  return {
    del: argv.includes("--delete"),
    email: get("email", "vapt.test@irisregtech.com"),
    username: get("username", "vapt_tester"),
    dept: get("dept", "carbon"),
    role: get("role", "user"),
  };
}

function generatePassword() {
  // base64url -> letters, digits, "-", "_" only (no ambiguous quoting issues
  // when this gets pasted into a terminal or a ticket).
  return crypto.randomBytes(15).toString("base64url");
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log("Connected to MongoDB.\n");

  const { del, email, username, dept, role } = parseArgs();
  const normalizedEmail = email.trim().toLowerCase();

  if (del) {
    const removed = await User.findOneAndDelete({ email: normalizedEmail });
    console.log(removed ? `Deleted VAPT test account: ${normalizedEmail}` : `No account found for ${normalizedEmail} — nothing to delete.`);
    await mongoose.disconnect();
    return;
  }

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    console.log(`An account already exists for ${normalizedEmail} (role: ${existing.role}). Not creating a duplicate.`);
    console.log(`If you need a fresh password, delete it first: node createVaptTestUser.js --delete --email=${normalizedEmail}`);
    await mongoose.disconnect();
    return;
  }

  const department = await Department.findOne({ code: dept.toLowerCase() });
  if (!department) {
    const all = await Department.find({});
    console.error(`No department with code "${dept}". Available: ${all.map((d) => d.code).join(", ")}`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const password = generatePassword();

  const user = new User({
    username,
    email: normalizedEmail,
    password, // hashed by the User model's pre-save hook
    role,
    authProvider: "local",
    isVerified: true, // skips the OTP step — nobody should be reading this inbox
    department: department._id,
  });

  await user.save();

  console.log("=== VAPT test account created ===");
  console.log(`  Email    : ${normalizedEmail}`);
  console.log(`  Password : ${password}`);
  console.log(`  Role     : ${role}`);
  console.log(`  Dept     : ${department.name} (${department.code})`);
  console.log("\nHand these to the VAPT team over a secure channel (not plaintext chat/email).");
  console.log(`When the engagement ends, remove it: node createVaptTestUser.js --delete --email=${normalizedEmail}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
