// Standalone operator diagnostic. Application entry points never import this module.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { ApiError, GoogleGenAI } from '@google/genai';

export const diagnosticAuthorization = 'approve-one-minimal-fictional-gemini-request';
const model = 'gemini-3.1-flash-lite';
const endpoint = 'https://generativelanguage.googleapis.com/v1/models/' + model + ':generateContent';
const prompt = 'A fictional shop sells blue kites. Suggest one fictional shop name.';
const googleStatuses = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED']);
const reasons = new Set(['API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'SERVICE_DISABLED', 'BILLING_DISABLED',
  'ACCESS_TOKEN_TYPE_UNSUPPORTED', 'LOCATION_POLICY_VIOLATED', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED']);
const domains = new Set(['googleapis.com', 'generativelanguage.googleapis.com']);
const fields = new Map([
  ['model', 'model'], ['contents', 'contents'], ['contents[0]', 'contents[0]'],
  ['contents[0].role', 'contents[0].role'], ['contents[0].parts', 'contents[0].parts'],
  ['contents[0].parts[0].text', 'contents[0].parts[0].text'],
  ['systemInstruction', 'systemInstruction'], ['system_instruction', 'systemInstruction'],
  ['generationConfig', 'generationConfig'], ['generation_config', 'generationConfig'],
  ['generationConfig.thinkingConfig.thinkingLevel', 'generationConfig.thinkingConfig.thinkingLevel'],
  ['generation_config.thinking_config.thinking_level', 'generationConfig.thinkingConfig.thinkingLevel']
]);

/** Convert human-readable error text to fixed hints. No substring of the response is copied into output. */
function summarize(message) {
  if (typeof message !== 'string') return 'NO_SAFE_MESSAGE_AVAILABLE';
  if (/unknown (?:name|field)|unrecognized (?:field|parameter)/i.test(message)) return 'UNRECOGNIZED_REQUEST_FIELD';
  if (/api key (?:is )?(?:not valid|invalid|expired)/i.test(message)) return 'API_KEY_REJECTED';
  if (/user location is not supported|location is not supported/i.test(message)) return 'LOCATION_NOT_SUPPORTED';
  if (/(?:not supported|unsupported).{0,80}(?:api version|generateContent)|(?:api version|generateContent).{0,80}(?:not supported|unsupported)/i.test(message)) {
    return 'API_VERSION_OR_METHOD_UNSUPPORTED';
  }
  return 'NO_SAFE_MESSAGE_AVAILABLE';
}

/** Accept only the SDK's structured JSON error envelope with a matching HTTP status. */
function safeRejection(error, httpStatus) {
  if (!(error instanceof ApiError) || error.status !== httpStatus || error.message.length > 16_384) return {};
  let body;
  try { body = JSON.parse(error.message)?.error; }
  catch { return {}; }
  if (body?.code !== httpStatus) return {};
  const googleStatus = googleStatuses.has(body.status) ? body.status : undefined;
  const details = Array.isArray(body.details) ? body.details : [];
  const errorInfo = details.filter(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
    .map(({ reason, domain }) => ({
      reason: reasons.has(reason) ? reason : 'UNRECOGNIZED',
      domain: domains.has(domain) ? domain : 'UNRECOGNIZED'
    }));
  const fieldViolations = [...new Set(details
    .filter(item => item?.['@type'] === 'type.googleapis.com/google.rpc.BadRequest' && Array.isArray(item.fieldViolations))
    .flatMap(item => item.fieldViolations.map(violation => fields.get(violation?.field) ?? 'UNRECOGNIZED')))];
  return { googleStatus, errorInfo, fieldViolations, messageSummary: summarize(body.message) };
}

/** Send a fixed fictional text request once. The transport guard also blocks SDK retries and redirects. */
export async function runMinimalGeminiDiagnostic({ authorization, environment, apiKey }, transport = fetch) {
  if (authorization !== diagnosticAuthorization || environment === 'production') throw new Error('DIAGNOSTIC_NOT_AUTHORIZED');
  if (typeof apiKey !== 'string' || !/^(?:AIza[A-Za-z0-9_-]{35}|AQ\.[A-Za-z0-9_-]{17,197})$/.test(apiKey) ||
    /[^A-Za-z0-9_.-]/.test(apiKey)) throw new Error('DIAGNOSTIC_KEY_UNAVAILABLE');
  let sent = false;
  let httpStatus;
  const sdk = new GoogleGenAI({ apiKey, vertexai: false, apiVersion: 'v1', httpOptions: {
    baseUrl: new URL(endpoint).origin, timeout: 9000, retryOptions: { attempts: 1 },
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (sent || url !== endpoint || init?.method !== 'POST') throw new Error('DIAGNOSTIC_TRANSPORT_DENIED');
      sent = true;
      const response = await transport(input, { ...init, redirect: 'error' });
      httpStatus = response.status;
      return response;
    }
  } });
  try {
    // Even a client-only config makes this SDK serialize generationConfig: {}.
    // Omit it entirely. No tools are supplied and the SDK client bounds transport.
    await sdk.models.generateContent({ model, contents: prompt });
    return { result: 'ACCEPTED', httpStatus };
  } catch (error) {
    return { result: httpStatus >= 400 && httpStatus < 500 ? 'REJECTED' : 'UNCONFIRMED',
      httpStatus, ...safeRejection(error, httpStatus) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const authorization = process.env.FL_P9_MINIMAL_DIAGNOSTIC_CONFIRM;
  const environment = process.env.NODE_ENV;
  if (authorization !== diagnosticAuthorization || environment === 'production') {
    console.error('DIAGNOSTIC_NOT_AUTHORIZED');
    process.exitCode = 1;
  } else {
    try {
      const workerEnv = parseEnv(await readFile(new URL('../.env.p9-runtime.local', import.meta.url), 'utf8'));
      const report = await runMinimalGeminiDiagnostic({ authorization, environment, apiKey: workerEnv.P9_GEMINI_API_KEY });
      console.log(JSON.stringify(report));
      if (report.result !== 'ACCEPTED') process.exitCode = 1;
    } catch {
      console.error('DIAGNOSTIC_CONFIGURATION_UNAVAILABLE');
      process.exitCode = 1;
    }
  }
}
