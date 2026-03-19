require('dotenv').config();

// On Render (and similar), credentials are in env, not a file. Write to temp file if provided.
const fs = require('fs');
const path = require('path');
const os = require('os');
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const credPath = path.join(os.tmpdir(), 'eknumber-google-credentials.json');
  fs.writeFileSync(credPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
}

const express = require('express');
const callHandler = require('./callHandler');
const speechService = require('./speechService');
const companyService = require('./companyService');
const exotelService = require('./exotelService');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log every request so you can see API calls in Render (or any host) logs
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  const callSid = req.query.CallSid || req.body?.CallSid || '';
  const extra = callSid ? ` CallSid=${callSid}` : '';
  console.log(`[${ts}] ${req.method} ${req.path}${extra}`);
  next();
});

function xml(res, body) {
  res.set('Content-Type', 'application/xml');
  res.send(body);
}

function exotelXml(res, responseBody) {
  const wrapped = `<?xml version="1.0" encoding="UTF-8"?><Response>${responseBody}</Response>`;
  xml(res, wrapped);
}

function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function baseUrl() {
  const url = process.env.BASE_URL || `http://localhost:${PORT}`;
  return url.replace(/\/$/, '');
}

function buildRecordAction() {
  return `${baseUrl()}/call/recording`;
}

function buildDigitsAction() {
  return `${baseUrl()}/call/digits`;
}

function safeExotelResponse(res, fallbackMessage, fn) {
  try {
    return fn();
  } catch (e) {
    console.error('Webhook error:', e);
    logger.logCall({
      outcome: 'error',
      error: e.message,
    });
    const msg = escapeXml(callHandler.getErrorPrompt());
    exotelXml(res, `<Say>${msg}</Say><Hangup/>`);
  }
}

app.post('/call/incoming', (req, res) => {
  safeExotelResponse(res, callHandler.getErrorPrompt(), () => {
    const body = req.body || {};
    const CallSid = body.CallSid || req.query.CallSid;
    const From = body.From || body.CallFrom || req.query.From || req.query.CallFrom;
    const To = body.To || body.CallTo || req.query.To || req.query.CallTo;
    const CallStatus = body.CallStatus || req.query.CallStatus;

    callHandler.getOrCreateState(CallSid, From, To);
    const welcome = escapeXml(callHandler.getWelcomePrompt());
    const recordAction = escapeXml(buildRecordAction());
    exotelXml(
      res,
      `<Say>${welcome}</Say><Record action="${recordAction}" maxLength="10" playBeep="true"/>`
    );
  });
});

// Passthru: start recording (Exotel Recording API). Creates state and sets StatusCallback so we get RecordingUrl later.
app.get('/call/start_recording', (req, res) => {
  const CallSid = req.query.CallSid;
  const From = req.query.From || req.query.CallFrom;
  const To = req.query.To || req.query.CallTo;
  if (!CallSid) {
    res.status(400).send('CallSid required');
    return;
  }
  callHandler.getOrCreateState(CallSid, From, To);
  const statusCallback = `${baseUrl()}/call/recording`;
  console.log(`[start_recording] Starting recording for CallSid=${CallSid}, callback=${statusCallback}`);
  exotelService
    .startRecording(CallSid, statusCallback)
    .then(() => {
      console.log(`[start_recording] OK for CallSid=${CallSid}`);
      res.status(200).send('OK');
    })
    .catch((e) => {
      console.error('Start recording error:', e);
      res.status(500).send('Error');
    });
});

// Passthru: stop recording. Exotel will POST RecordingUrl to StatusCallback (/call/recording) when ready.
app.get('/call/stop_recording', (req, res) => {
  const CallSid = req.query.CallSid;
  if (!CallSid) {
    res.status(400).send('CallSid required');
    return;
  }
  console.log(`[stop_recording] Stopping recording for CallSid=${CallSid}`);
  exotelService
    .stopRecording(CallSid)
    .then(() => {
      console.log(`[stop_recording] OK for CallSid=${CallSid}`);
      res.status(200).send('OK');
    })
    .catch((e) => {
      console.error('Stop recording error:', e);
      res.status(500).send('Error');
    });
});

// Passthru: wait (delay). Use when Exotel has no "Timing/Wait" applet. Holds the request then returns 200.
// After Greeting: /call/wait?seconds=3 (user speaks). After stop_recording: /call/wait?seconds=5 (for callback).
app.get('/call/wait', (req, res) => {
  const raw = req.query.seconds;
  const sec = Math.min(Math.max(parseInt(raw, 10) || 3, 1), 30);
  setTimeout(() => res.status(200).send('OK'), sec * 1000);
});

// True when Exotel sent this as Recording API StatusCallback (we just acknowledge with 200, no XML).
function isRecordingStatusCallback(req) {
  const body = req.body || {};
  return body.Status != null || body.DateUpdated != null || req.query.Status != null || req.query.DateUpdated != null;
}

app.post('/call/recording', async (req, res) => {
  safeExotelResponse(res, callHandler.getErrorPrompt(), async () => {
    const body = req.body || {};
    const CallSid = body.CallSid || req.query.CallSid;
    const RecordingUrl = body.RecordingUrl || req.query.RecordingUrl;
    const From = body.From || body.CallFrom || req.query.From || req.query.CallFrom;
    const To = body.To || body.CallTo || req.query.To || req.query.CallTo;
    const isCallback = isRecordingStatusCallback(req);

    if (!CallSid || !RecordingUrl) {
      if (isCallback) res.status(200).send('OK');
      else exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      return;
    }

    let state = callHandler.getState(CallSid);
    if (!state) state = callHandler.getOrCreateState(CallSid, From, To);

    console.log(`[recording] Processing RecordingUrl for CallSid=${CallSid}`);
    let transcript = null;
    try {
      transcript = await speechService.transcribeFromUrl(RecordingUrl);
    } catch (e) {
      console.error('STT error:', e);
      logger.logCall({
          callSid: CallSid,
          transcript: null,
          matchedCompany: null,
          transferNumber: null,
          outcome: 'error',
          error: e.message,
        });
      if (isCallback) res.status(200).send('OK');
      else exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      return;
    }

    const matchResult = await companyService.matchCompany(transcript || '');
    callHandler.setState(CallSid, {
      ...state,
      transcript,
      matchResult,
      step: matchResult.type === 'strong' ? 'transfer' : matchResult.type === 'ambiguous' ? 'ambiguous' : 'not_found',
    });

    if (matchResult.type === 'strong' && matchResult.company) {
      const company = matchResult.company;
      const supportNumber = company.support_number;
      if (!supportNumber || String(supportNumber).toLowerCase().includes('no phone')) {
        const notFound = escapeXml(callHandler.getNotFoundPrompt(company.name));
        if (isCallback) res.status(200).send('OK');
        else exotelXml(res, `<Say>${notFound}</Say><Redirect>${escapeXml(buildRecordAction())}</Redirect>`);
        return;
      }
      try {
        await exotelService.transferCall(state.from, supportNumber);
        logger.logCall({
          callSid: CallSid,
          transcript,
          matchedCompany: company.name,
          transferNumber: supportNumber,
          outcome: 'connected',
        });
        if (isCallback) res.status(200).send('OK');
        else {
          const connecting = escapeXml(callHandler.getConnectingPrompt(company.name));
          exotelXml(res, `<Say>${connecting}</Say><Hangup/>`);
        }
      } catch (e) {
        console.error('Transfer error:', e);
        logger.logCall({
          callSid: CallSid,
          transcript,
          matchedCompany: company.name,
          transferNumber: supportNumber,
          outcome: 'error',
          error: e.message,
        });
        if (isCallback) res.status(200).send('OK');
        else exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      }
      return;
    }

    if (matchResult.type === 'ambiguous' && matchResult.companies && matchResult.companies.length >= 2) {
      callHandler.setState(CallSid, { ...callHandler.getState(CallSid), step: 'ambiguous' });
      if (isCallback) res.status(200).send('OK');
      else {
        const a = matchResult.companies[0].name;
        const b = matchResult.companies[1].name;
        const prompt = escapeXml(callHandler.getAmbiguousPrompt(a, b));
        const digitsAction = escapeXml(buildDigitsAction());
        exotelXml(res, `<Say>${prompt}</Say><Gather action="${digitsAction}" numDigits="1" timeout="5"/>`);
      }
      return;
    }

    const retryCount = (state.retryCount || 0) + 1;
    callHandler.setState(CallSid, { ...callHandler.getState(CallSid), retryCount });

    if (retryCount >= callHandler.getMaxRetries()) {
      logger.logCall({
        callSid: CallSid,
        transcript,
        matchedCompany: null,
        transferNumber: null,
        outcome: 'not_found',
      });
      if (isCallback) res.status(200).send('OK');
      else exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      return;
    }

    const notFound = escapeXml(callHandler.getNotFoundPrompt(transcript || 'that'));
    if (isCallback) res.status(200).send('OK');
    else exotelXml(res, `<Say>${notFound}</Say><Record action="${escapeXml(buildRecordAction())}" maxLength="10" playBeep="true"/>`);
  });
});

app.post('/call/digits', (req, res) => {
  safeExotelResponse(res, callHandler.getErrorPrompt(), () => {
    const body = req.body || {};
    const CallSid = body.CallSid || req.query.CallSid;
    let digits = body.digits || req.query.digits || '';
    if (typeof digits === 'string' && (digits.startsWith('"') || digits.endsWith('"'))) {
      digits = digits.trim().replace(/^"|"$/g, '');
    }
    const From = body.From || body.CallFrom || req.query.From || req.query.CallFrom;
    const To = body.To || body.CallTo || req.query.To || req.query.CallTo;

    const state = callHandler.getState(CallSid);
    if (!state || !state.matchResult || state.matchResult.type !== 'ambiguous' || !state.matchResult.companies) {
      exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      return;
    }

    const choice = digits === '1' ? 0 : digits === '2' ? 1 : null;
    const company = choice !== null ? state.matchResult.companies[choice] : null;

    if (choice === null) {
      exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      return;
    }
    if (!company || !company.support_number || String(company.support_number).toLowerCase().includes('no phone')) {
      exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      return;
    }

    exotelService
      .transferCall(state.from, company.support_number)
      .then(() => {
        logger.logCall({
          callSid: CallSid,
          transcript: state.transcript,
          matchedCompany: company.name,
          transferNumber: company.support_number,
          outcome: 'connected',
        });
        const connecting = escapeXml(callHandler.getConnectingPrompt(company.name));
        exotelXml(res, `<Say>${connecting}</Say><Hangup/>`);
      })
      .catch((e) => {
        console.error('Transfer error:', e);
        logger.logCall({
          callSid: CallSid,
          transcript: state.transcript,
          matchedCompany: company.name,
          transferNumber: company.support_number,
          outcome: 'error',
          error: e.message,
        });
        exotelXml(res, `<Say>${escapeXml(callHandler.getErrorPrompt())}</Say><Hangup/>`);
      });
  });
});

app.get('/call/connect', async (req, res) => {
  const CallSid = req.query.CallSid;
  const state = CallSid ? callHandler.getState(CallSid) : null;
  if (!state || state.step !== 'transfer' || !state.matchResult || !state.matchResult.company) {
    res.set('Content-Type', 'application/json');
    return res.json({ destination: { numbers: [] } });
  }
  const company = state.matchResult.company;
  const num = company.support_number;
  if (!num || String(num).toLowerCase().includes('no phone')) {
    res.set('Content-Type', 'application/json');
    return res.json({ destination: { numbers: [] } });
  }
  const normalized = exotelService.normalizePhone(num);
  const e164 = normalized.length <= 11 ? `+91${normalized.replace(/^0/, '')}` : `+91${normalized}`;
  res.set('Content-Type', 'application/json');
  res.json({
    destination: { numbers: [e164] },
    start_call_playback: {
      playback_to: 'both',
      type: 'text',
      value: callHandler.getConnectingPrompt(company.name),
    },
  });
});

app.post('/admin/refresh', async (req, res) => {
  try {
    await companyService.refreshCache();
    res.json({ ok: true, message: 'Company cache refreshed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

async function start() {
  await companyService.getCompanies(true);
  app.listen(PORT, () => {
    console.log(`EkNumber server running on port ${PORT}`);
  });
}

start().catch((e) => {
  console.error('Startup error:', e);
  process.exit(1);
});
