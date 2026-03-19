const axios = require('axios');

const sid = process.env.EXOTEL_SID; // Account SID (used in URL path)
const apiKey = process.env.EXOTEL_API_KEY || sid; // API Key = Basic auth username (often different from SID!)
const token = process.env.EXOTEL_TOKEN;
const virtualNumber = process.env.EXOTEL_VIRTUAL_NUMBER;
const subdomain = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';

function getAuth() {
  return Buffer.from(`${apiKey}:${token}`).toString('base64');
}

/**
 * Transfer the call to the company's support number.
 * Connects the caller (From) to the support number (To). Exotel Connect API:
 * From = number to call first (agent/support), To = customer. So we connect
 * support line to customer: From=customer, To=support with CallerId=virtual.
 * Actually: "From = Agent's phone # that will be called first", "To = Customer".
 * So we want: Agent = support number (called first), Customer = caller. So From=support_number, To=caller.
 * But we're IN a call already - the caller called us. So we need "connect this call to support_number".
 * Exotel's "connect" in flow might be different. API "Calls/connect" connects From to To - From is called first, then To.
 * So From = support number (we're not calling them - we're transferring). Need to check "transfer" vs "connect".
 * For transfer: typically we have call leg A (caller) and we want to connect to B (support). So we'd do connect(From=caller, To=support) but that would call caller first. So it's Connect(From=support, To=caller) - call support first, then connect caller? No.
 * Reading again: "It will connect the 'From' number first. Once the person at the 'From' end picks up the phone, it will connect to the number provided in the 'To'."
 * So From is called first, then To. So we have: current caller = C. We want C to talk to support S. So we need to call S first (From=S), then connect C (To=C). So From = support_number, To = caller_number, CallerId = our virtual number.
 */
async function transferCall(callerNumber, supportNumber) {
  if (!sid || !token || !virtualNumber) {
    throw new Error('Missing Exotel credentials (EXOTEL_SID, EXOTEL_TOKEN, EXOTEL_VIRTUAL_NUMBER)');
  }

  const from = normalizePhone(supportNumber);
  const to = normalizePhone(callerNumber);

  const url = `https://${subdomain}/v1/Accounts/${sid}/Calls/connect.json`;
  const response = await axios.post(
    url,
    new URLSearchParams({
      From: from,
      To: to,
      CallerId: virtualNumber,
      CallType: 'trans',
    }),
    {
      headers: {
        Authorization: `Basic ${getAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data;
}

function normalizePhone(num) {
  const n = String(num).replace(/\D/g, '');
  if (n.length === 10) return '0' + n;
  if (n.length === 11 && n.startsWith('0')) return n;
  if (n.length >= 10) return n.slice(-11);
  return '0' + n;
}

/**
 * Start recording the current call. Pass StatusCallback so Exotel POSTs RecordingUrl when done.
 */
async function startRecording(callSid, statusCallbackUrl) {
  if (!sid || !token) throw new Error('Missing Exotel credentials');
  const url = `https://${subdomain}/v1/Accounts/${sid}/Calls/${callSid}/recording.json`;
  await axios.post(
    url,
    new URLSearchParams({
      Action: 'START',
      RecordingChannels: 'single',
      RecordingFormat: 'mp3',
      Leg1Recording: 'True',
      ...(statusCallbackUrl && { StatusCallback: statusCallbackUrl }),
    }),
    {
      headers: {
        Authorization: `Basic ${getAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
}

/**
 * Stop recording the current call. RecordingUrl will be sent to the StatusCallback URL.
 */
async function stopRecording(callSid) {
  if (!sid || !token) throw new Error('Missing Exotel credentials');
  const url = `https://${subdomain}/v1/Accounts/${sid}/Calls/${callSid}/recording.json`;
  await axios.post(
    url,
    new URLSearchParams({ Action: 'STOP' }),
    {
      headers: {
        Authorization: `Basic ${getAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
}

module.exports = {
  transferCall,
  normalizePhone,
  startRecording,
  stopRecording,
};
