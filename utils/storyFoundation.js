const axios = require("axios");
const { registerSoundOnChain } = require("./storyOnChain");

function formatAxiosError(err) {
  const code = err?.code || err?.cause?.code;
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  const url = err?.config?.url;

  // AggregateError from follow-redirects can hide message; pull inner codes if present
  const innerErrors = err?.errors || err?.cause?.errors || err?.cause?.[Symbol.for("errors")] || err?.cause?.errors;
  const innerCodes =
    Array.isArray(innerErrors) && innerErrors.length > 0
      ? innerErrors
          .map((e) => e?.code)
          .filter(Boolean)
          .join(", ")
      : "";

  const parts = [];
  if (code) parts.push(code);
  if (innerCodes && !parts.includes(innerCodes)) parts.push(innerCodes);
  if (status) parts.push(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
  if (err?.message && err.message !== "Error") parts.push(err.message);
  if (url) parts.push(`url: ${url}`);

  return parts.length > 0 ? parts.join(" | ") : "Unknown error";
}

async function safeAxios(action, fn) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status;
    const url = err?.config?.url;
    if (status === 404 && typeof url === "string" && url.includes("/ip/register")) {
      throw new Error(
        `${action} failed: HTTP 404 Not Found | url: ${url} | ` +
          `The Story Protocol API v4 base URL does not include a REST "/ip/register" endpoint. ` +
          `To "register" IP you typically need to do an on-chain registration using the Story SDK, ` +
          `or set STORY_FOUNDATION_REGISTER_PATH to the correct endpoint provided by your Story service.`
      );
    }
    // Never leak headers / api keys; only return safe info
    throw new Error(`${action} failed: ${formatAxiosError(err)}`);
  }
}

/**
 * Register an IP record on Story Foundation.
 *
 * This uses a configurable HTTP API so it can work in any environment.
 *
 * Required env:
 * - STORY_FOUNDATION_API_URL
 * - STORY_FOUNDATION_X_API_KEY (preferred) or STORY_FOUNDATION_API_KEY
 *
 * Optional env:
 * - STORY_FOUNDATION_REGISTER_PATH (default: /ip/register)
 * - STORY_FOUNDATION_AUTH_HEADER (default: X-API-Key)
 * - STORY_FOUNDATION_AUTH_SCHEME (default: none; set to "Bearer" to use Authorization: Bearer <key>)
 */
function getStoryFoundationClientConfig() {
  const baseUrl = process.env.STORY_FOUNDATION_API_URL;
  const apiKey = process.env.STORY_FOUNDATION_X_API_KEY || process.env.STORY_FOUNDATION_API_KEY;
  const authHeader = process.env.STORY_FOUNDATION_AUTH_HEADER || "X-API-Key";
  const authScheme = process.env.STORY_FOUNDATION_AUTH_SCHEME; // e.g. "Bearer"

  const missing = [];
  if (!baseUrl) missing.push("STORY_FOUNDATION_API_URL");
  if (!apiKey) missing.push("STORY_FOUNDATION_X_API_KEY (or STORY_FOUNDATION_API_KEY)");
  if (missing.length > 0) {
    throw new Error(`Story Foundation API is not configured (missing: ${missing.join(", ")})`);
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (authHeader.toLowerCase() === "authorization" && authScheme) {
    headers.Authorization = `${authScheme} ${apiKey}`;
  } else if (authHeader.toLowerCase() === "authorization") {
    headers.Authorization = apiKey;
  } else {
    headers[authHeader] = apiKey;
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), headers };
}

async function registerSoundIP({ fileHash, fileUrl, metadata }) {
  // Option A: on-chain Story registration (recommended)
  if (process.env.STORY_ONCHAIN_PRIVATE_KEY || process.env.STORY_SPG_NFT_CONTRACT) {
    return await registerSoundOnChain({ fileHash, fileUrl, metadata });
  }

  const baseUrl = process.env.STORY_FOUNDATION_API_URL;
  const registerPath = process.env.STORY_FOUNDATION_REGISTER_PATH || "/ip/register";
  const { headers } = getStoryFoundationClientConfig();

  const response = await safeAxios("Story Foundation register", async () =>
    axios.post(
      `${baseUrl.replace(/\/$/, "")}${registerPath.startsWith("/") ? "" : "/"}${registerPath}`,
      {
        assetType: "sound",
        fileHash,
        fileUrl,
        metadata,
      },
      {
        headers,
        timeout: 60000,
      }
    )
  );

  const data = response.data || {};
  return {
    storyFoundationId: data.storyFoundationId || data.id || data.registrationId || "",
    timestamp: data.timestamp || data.createdAt || new Date().toISOString(),
    proof: data.proof || data.attestation || data.receipt || data,
    raw: data,
  };
}

/**
 * List sound IP registrations for a creator.
 *
 * Required env:
 * - STORY_FOUNDATION_API_URL
 * - STORY_FOUNDATION_X_API_KEY (preferred) or STORY_FOUNDATION_API_KEY
 *
 * Optional env:
 * - STORY_FOUNDATION_LIST_PATH (default: /ip/list)
 */
async function listSoundRegistrations({ creatorUserId }) {
  const listPath = process.env.STORY_FOUNDATION_LIST_PATH || "/ip/list";
  const { baseUrl, headers } = getStoryFoundationClientConfig();

  const response = await safeAxios("Story Foundation list registrations", async () =>
    axios.get(`${baseUrl}${listPath.startsWith("/") ? "" : "/"}${listPath}`, {
      headers,
      timeout: 60000,
      params: {
        assetType: "sound",
        creatorUserId,
      },
    })
  );

  const data = response.data;
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.registrations)
        ? data.registrations
        : Array.isArray(data?.data)
          ? data.data
          : [];

  return items.map((item) => {
    const metadata = item?.metadata || item?.meta || {};
    return {
      storyFoundationId: item?.storyFoundationId || item?.id || item?.registrationId || "",
      timestamp: item?.timestamp || item?.createdAt || item?.time || null,
      fileHash: item?.fileHash || item?.hash || item?.contentHash || item?.audioHash || "",
      fileUrl: item?.fileUrl || item?.url || item?.assetUrl || "",
      metadata,
      raw: item,
    };
  });
}

/**
 * Fetch a proof (PDF or JSON) for a Story Foundation registration.
 *
 * Optional env:
 * - STORY_FOUNDATION_PROOF_PATH (default: /ip/proof)
 */
async function fetchSoundProof({ storyFoundationId, creatorUserId, platformSoundId, fileHash }) {
  const proofPath = process.env.STORY_FOUNDATION_PROOF_PATH || "/ip/proof";
  const { baseUrl, headers } = getStoryFoundationClientConfig();

  const response = await safeAxios("Story Foundation fetch proof", async () =>
    axios.get(`${baseUrl}${proofPath.startsWith("/") ? "" : "/"}${proofPath}`, {
      headers,
      timeout: 60000,
      responseType: "arraybuffer",
      params: {
        assetType: "sound",
        storyFoundationId,
        creatorUserId,
        platformSoundId,
        fileHash,
      },
      validateStatus: (status) => status >= 200 && status < 300,
    })
  );

  const contentType = (response.headers?.["content-type"] || "").toLowerCase();
  const buf = Buffer.from(response.data);

  if (contentType.includes("application/pdf")) {
    return { buffer: buf, mimeType: "application/pdf", ext: "pdf" };
  }

  // JSON (or unknown) fallback
  try {
    const text = buf.toString("utf8");
    const parsed = JSON.parse(text);
    const normalized = Buffer.from(JSON.stringify(parsed, null, 2), "utf8");
    return { buffer: normalized, mimeType: "application/json", ext: "json" };
  } catch {
    return { buffer: buf, mimeType: "application/octet-stream", ext: "bin" };
  }
}

/**
 * Fetch a registration record for a Story Foundation ID (JSON).
 *
 * Optional env:
 * - STORY_FOUNDATION_REGISTRATION_PATH (default: /ip/registration)
 */
async function fetchSoundRegistration({ storyFoundationId }) {
  const registrationPath = process.env.STORY_FOUNDATION_REGISTRATION_PATH || "/ip/registration";
  const { baseUrl, headers } = getStoryFoundationClientConfig();

  const response = await safeAxios("Story Foundation fetch registration", async () =>
    axios.get(`${baseUrl}${registrationPath.startsWith("/") ? "" : "/"}${registrationPath}`, {
      headers,
      timeout: 60000,
      params: {
        assetType: "sound",
        storyFoundationId,
      },
    })
  );

  const data = response.data || {};
  const item =
    data?.item ||
    data?.registration ||
    data?.data ||
    data;

  const metadata = item?.metadata || item?.meta || {};

  return {
    storyFoundationId: item?.storyFoundationId || item?.id || item?.registrationId || storyFoundationId,
    timestamp: item?.timestamp || item?.createdAt || item?.time || null,
    fileHash: item?.fileHash || item?.hash || item?.contentHash || item?.audioHash || "",
    metadata,
    raw: item,
  };
}

module.exports = {
  registerSoundIP,
  listSoundRegistrations,
  fetchSoundProof,
  fetchSoundRegistration,
};

