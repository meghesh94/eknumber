const callState = new Map();
const MAX_RETRIES = 2;

const PROMPTS = {
  welcome:
    'Namaste. EkNumber pe aapka swagat hai. Aap kis company ka support chahte hain? Beep ke baad boliye.',
  connecting: (company) =>
    `Connecting you to ${company} support. Please hold.`,
  ambiguous: (a, b) =>
    `Did you mean ${a}, press 1. Or ${b}, press 2.`,
  notFound: (transcript) =>
    `Sorry, we could not find ${transcript}. Please try again after the beep.`,
  error: 'Something went wrong. Please call back in a moment.',
};

function getState(callSid) {
  return callState.get(callSid);
}

function setState(callSid, state) {
  callState.set(callSid, { ...state, updatedAt: Date.now() });
}

function deleteState(callSid) {
  callState.delete(callSid);
}

function getOrCreateState(callSid, from, to) {
  let s = callState.get(callSid);
  if (!s) {
    s = {
      callSid,
      from,
      to,
      step: 'welcome',
      retryCount: 0,
      transcript: null,
      matchResult: null,
      ambiguousChoice: null,
    };
    callState.set(callSid, { ...s, updatedAt: Date.now() });
  }
  return s;
}

function getWelcomePrompt() {
  return PROMPTS.welcome;
}

function getConnectingPrompt(companyName) {
  return PROMPTS.connecting(companyName);
}

function getAmbiguousPrompt(companyA, companyB) {
  return PROMPTS.ambiguous(companyA, companyB);
}

function getNotFoundPrompt(transcript) {
  return PROMPTS.notFound(transcript || 'that');
}

function getErrorPrompt() {
  return PROMPTS.error;
}

function getMaxRetries() {
  return MAX_RETRIES;
}

module.exports = {
  callState,
  getState,
  setState,
  deleteState,
  getOrCreateState,
  getWelcomePrompt,
  getConnectingPrompt,
  getAmbiguousPrompt,
  getNotFoundPrompt,
  getErrorPrompt,
  getMaxRetries,
  PROMPTS,
};
