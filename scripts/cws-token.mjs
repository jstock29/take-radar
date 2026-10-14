// Exchange a service account JSON key for a Chrome Web Store access token,
// using Google's standard JWT bearer flow. Needs no IAM roles on the account
// (unlike impersonation via the IAM Credentials API) and no dependencies.
//
//   CWS_SERVICE_ACCOUNT_KEY='{...}' node scripts/cws-token.mjs
//
// Prints the token on stdout.
import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

const raw = process.env.CWS_SERVICE_ACCOUNT_KEY;
if (!raw) {
  console.error("CWS_SERVICE_ACCOUNT_KEY is not set.");
  process.exit(1);
}

let key;
try {
  key = JSON.parse(raw);
} catch {
  console.error("CWS_SERVICE_ACCOUNT_KEY is not valid JSON. Paste the whole key file.");
  process.exit(1);
}
if (key.type !== "service_account" || !key.private_key || !key.client_email) {
  console.error("CWS_SERVICE_ACCOUNT_KEY doesn't look like a service account key file.");
  process.exit(1);
}

const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
const b64url = (data) => Buffer.from(data).toString("base64url");
const now = Math.floor(Date.now() / 1000);

const unsigned = [
  b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })),
  b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  ),
].join(".");
const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

const res = await fetch(tokenUri, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature}`,
  }),
});
const body = await res.json().catch(() => ({}));

if (!res.ok || !body.access_token) {
  console.error(
    `Token request for ${key.client_email} failed (HTTP ${res.status}): ${JSON.stringify(body)}`,
  );
  process.exit(1);
}
process.stdout.write(body.access_token);
