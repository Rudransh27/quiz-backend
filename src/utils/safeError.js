// src/utils/safeError.js
// Security scan fix (CWE-209, Information Exposure Through an Error Message).
// Route catch blocks used to send `err.message` straight to the browser,
// leaking Mongo/Mongoose internals (collection paths, cast/duplicate-key
// details, stack-ish text). handleError() is now the ONE place a caught error
// becomes an HTTP response:
//   • 5xx → full error logged server-side with a short reference id; the user
//           only sees a generic message plus that id (to quote to support).
//   • 4xx → messages WE wrote (schema validators like "Please provide a region
//           name", errors thrown with `expose`/`status`) still reach the user;
//           raw database/driver internals are swapped for plain wording.
const crypto = require("crypto");

const GENERIC_SERVER_MESSAGE = "Something went wrong on our side. Please try again later.";
const GENERIC_CLIENT_MESSAGE = "The request could not be processed. Please check your input and try again.";

// Mongoose's own (non-custom) messages mention paths/models/types —
// e.g. 'Cast to ObjectId failed for value "x" (type string) at path "_id"'.
const INTERNAL_TEXT = /cast to|at path|for model|E11000|duplicate key|Mongo|buffering timed out|ECONN|is not a function|is not defined|Cannot read propert|Unexpected token/i;

function clientSafeMessage(err) {
  if (!err) return GENERIC_CLIENT_MESSAGE;
  if (err.code === 11000) return "A record with this value already exists.";
  if (err.name === "CastError") return "Invalid ID or value provided.";
  if (err.name === "ValidationError" && err.errors) {
    // Only messages a developer wrote in a schema (required/custom
    // validators) are user-facing; Mongoose's built-in texts are not.
    const custom = Object.values(err.errors)
      .filter((e) => ["required", "user defined"].includes(e.kind) && e.message && !INTERNAL_TEXT.test(e.message))
      .map((e) => e.message);
    return custom.length ? custom.join(" ") : GENERIC_CLIENT_MESSAGE;
  }
  const message = typeof err === "string" ? err : err.message;
  if (!message || INTERNAL_TEXT.test(message)) return GENERIC_CLIENT_MESSAGE;
  return message;
}

function handleError(res, err, status = 500) {
  const req = res.req || {};
  const where = `${req.method || ""} ${req.originalUrl || ""}`.trim();

  if (status >= 500) {
    const ref = crypto.randomBytes(4).toString("hex");
    console.error(`❌ [${ref}] ${where} failed:`, err && err.stack ? err.stack : err);
    return res.status(status).json({ success: false, message: GENERIC_SERVER_MESSAGE, ref });
  }

  const message = clientSafeMessage(err);
  if (message !== (err && err.message)) {
    console.warn(`⚠️ ${where} rejected (${status}):`, err && err.message ? err.message : err);
  }
  return res.status(status).json({ success: false, message });
}

module.exports = { handleError, clientSafeMessage, GENERIC_SERVER_MESSAGE };
