const multer = require('multer');

// Configure Multer to store the file in memory
const storage = multer.memoryStorage();

// 🔒 What each upload field may contain. Uploads are admin-only, but the
// files are served publicly from Cloudinary, so: no SVG/HTML (script),
// an extension + mimetype allow-list per field, a size cap, and a check of
// the file's first bytes for the binary types (the browser-sent mimetype
// alone is just a claim).
const MB = 1024 * 1024;
const RULES = {
  image: { ext: /\.(png|jpe?g|gif|webp)$/i, mime: /^image\/(png|jpeg|gif|webp)$/, maxBytes: 10 * MB, sniff: 'image' },
  video: { ext: /\.(mp4|webm|mov|m4v)$/i, mime: /^video\/(mp4|webm|quicktime|x-m4v)$/, maxBytes: 500 * MB },
  document: {
    ext: /\.(pdf|ppt|pptx)$/i,
    mime: /^application\/(pdf|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation|octet-stream)$/,
    maxBytes: 100 * MB,
    sniff: 'document',
  },
  file: { ext: /\.csv$/i, mime: /^(text\/(csv|plain)|application\/(vnd\.ms-excel|csv|octet-stream))$/, maxBytes: 5 * MB },
};
const MAX_BYTES = Math.max(...Object.values(RULES).map((r) => r.maxBytes));

function fileFilter(req, file, cb) {
  const rule = RULES[file.fieldname];
  if (!rule || !rule.ext.test(file.originalname || '') || !rule.mime.test(file.mimetype || '')) {
    const err = new Error(`That file type isn't allowed for "${file.fieldname}".`);
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

// Magic bytes: PNG, JPEG, GIF, WEBP / PDF, legacy PPT (OLE2), PPTX (zip).
function looksLike(kind, buf) {
  if (!buf || buf.length < 12) return false;
  const hex = buf.subarray(0, 8).toString('hex');
  if (kind === 'image') {
    return hex.startsWith('89504e47') || hex.startsWith('ffd8ff') || hex.startsWith('47494638')
      || (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP');
  }
  if (kind === 'document') {
    return buf.subarray(0, 5).toString('ascii') === '%PDF-' || hex.startsWith('d0cf11e0a1b11ae1') || hex.startsWith('504b0304');
  }
  return true;
}

const base = multer({ storage, limits: { fileSize: MAX_BYTES, files: 1 }, fileFilter });

// Same API as a plain multer instance (upload.single(field)) — returns the
// multer middleware plus a per-field size/signature check, and turns
// multer's errors into 400s instead of 500s.
const upload = {
  single(field) {
    const parse = (req, res, next) => base.single(field)(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : (err.status || 400)).json({ success: false, message: tooBig ? 'That file is too large.' : err.message });
    });
    const verify = (req, res, next) => {
      const rule = RULES[field];
      if (!req.file || !rule) return next();
      if (req.file.size > rule.maxBytes) return res.status(413).json({ success: false, message: 'That file is too large.' });
      if (rule.sniff && !looksLike(rule.sniff, req.file.buffer)) {
        return res.status(400).json({ success: false, message: "The file's contents don't match its type." });
      }
      return next();
    };
    return [parse, verify];
  },
};

module.exports = upload;
module.exports.RULES = RULES;
module.exports.looksLike = looksLike;
