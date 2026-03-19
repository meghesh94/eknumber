const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'calls.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function formatEntry(entry) {
  return `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
}

function logCall(entry) {
  const line = formatEntry(entry);
  console.log(line.trim());
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('Failed to write to call log file:', err.message);
  }
}

module.exports = {
  logCall,
  LOG_FILE,
};
