const fs = require('fs');
const path = require('path');
const axios = require('axios');
const speech = require('@google-cloud/speech');

const client = new speech.SpeechClient();

const TMP_DIR = process.platform === 'win32' ? path.join(process.cwd(), 'tmp') : '/tmp';

function ensureTmpDir() {
  const dir = path.join(TMP_DIR, 'eknumber');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Download audio from URL to a temp file and return path.
 */
async function downloadAudio(recordingUrl) {
  const dir = ensureTmpDir();
  const filename = `rec_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`;
  const filepath = path.join(dir, filename);

  const response = await axios({
    method: 'get',
    url: recordingUrl,
    responseType: 'stream',
  });

  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(filepath));
    writer.on('error', reject);
  });
}

/**
 * Transcribe audio file using Google Cloud Speech-to-Text.
 * Returns transcript string or null on failure.
 */
async function transcribe(filepath) {
  const content = fs.readFileSync(filepath).toString('base64');

  const [response] = await client.recognize({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 8000,
      languageCode: 'en-IN',
      alternativeLanguageCodes: ['hi-IN'],
      maxAlternatives: 1,
    },
    audio: {
      content,
    },
  });

  const transcript = response.results
    ? response.results.map((r) => r.alternatives[0].transcript).join(' ')
    : '';

  return transcript.trim() || null;
}

/**
 * Download recording from Exotel, transcribe with Google STT, then delete temp file.
 */
async function transcribeFromUrl(recordingUrl) {
  let filepath = null;
  try {
    filepath = await downloadAudio(recordingUrl);
    const transcript = await transcribe(filepath);
    return transcript;
  } finally {
    if (filepath && fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        console.error('Failed to delete temp audio:', e.message);
      }
    }
  }
}

module.exports = {
  transcribeFromUrl,
  transcribe,
  downloadAudio,
};
