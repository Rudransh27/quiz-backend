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

module.exports = { escapeCsvField, buildCsv };
