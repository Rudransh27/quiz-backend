// src/utils/csvBuilder.js
const escapeCsvField = (value) => {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const buildCsv = (headers, rows) => {
  const lines = [headers.map(escapeCsvField).join(',')];
  rows.forEach(row => {
    lines.push(row.map(escapeCsvField).join(','));
  });
  return lines.join('\r\n');
};

// RFC4180-style parser — mirrors escapeCsvField's quoting rules (fields are
// only ever quoted when they contain a comma/quote/newline, quotes inside a
// quoted field are doubled). Returns rows as { headerName: value } objects,
// same shape XLSX.utils.sheet_to_json produces, so callers can read
// row["Column Name"] regardless of which parser produced the row.
const parseCsv = (text) => {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else {
      field += ch;
    }
  }
  // Final field/row if the file doesn't end with a newline
  if (field !== '' || row.length > 0) pushRow();

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1)
    .filter(r => r.some(v => v !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
      return obj;
    });
};

module.exports = { escapeCsvField, buildCsv, parseCsv };
