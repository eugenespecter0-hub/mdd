const { StoryClient } = require("@story-protocol/core-sdk");
const { http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { WIP_TOKEN_ADDRESS } = require("@story-protocol/core-sdk");
const { uploadToR2 } = require("./cloudflareR2");

function normalizePrivateKey(input) {
  if (!input) return "";
  let key = String(input).trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (key && !key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return "";
  return key;
}

function isEvmAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(addr || ""));
}

function getOnChainLicenseConfig() {
  const privateKey = normalizePrivateKey(process.env.STORY_ONCHAIN_PRIVATE_KEY);
  const chainId = Number(process.env.STORY_ONCHAIN_CHAIN_ID || 1315);
  const rpcUrl = process.env.STORY_ONCHAIN_RPC_URL || "https://aeneid.storyrpc.io";
  if (!privateKey) {
    throw new Error("Missing STORY_ONCHAIN_PRIVATE_KEY for on-chain licensing");
  }
  return { privateKey, chainId, rpcUrl };
}

function getLicensePilFlavor(licenseType) {
  const t = String(licenseType || "");
  if (t === "personal_noncommercial") return "non_commercial_social_remixing";
  if (t === "commercial_online") return "commercial_use";
  if (t === "commercial_film_tv") return "commercial_use";
  if (t === "exclusive_buyout") return "commercial_use";
  return "commercial_use";
}

function buildPilTermsFromTemplate({ template, uri }) {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const type = String(template?.licenseType || "");

  const isNonCommercial = type === "personal_noncommercial";
  const commercialUse = !isNonCommercial;

  // Minimal PIL terms that encode "commercial/non-commercial" + a URI that contains the detailed legal text.
  return {
    transferable: false,
    royaltyPolicy: undefined, // default LAP
    defaultMintingFee: 0,
    expiration: 0,
    commercialUse,
    commercialAttribution: Boolean(template?.attributionRequired) && commercialUse,
    commercializerChecker: ZERO,
    commercializerCheckerData: ZERO,
    commercialRevShare: 0,
    commercialRevCeiling: 0,
    derivativesAllowed: false,
    derivativesAttribution: false,
    derivativesApproval: false,
    derivativesReciprocal: false,
    derivativeRevCeiling: 0,
    currency: WIP_TOKEN_ADDRESS,
    uri: uri || "",
  };
}

async function ensureLicenseTermsForTemplate({ template, client }) {
  if (!template) throw new Error("Template is required");

  // Already known
  if (template.storyLicenseTermsId) {
    return {
      licenseTermsId: template.storyLicenseTermsId,
      pilFlavor: template.storyPilFlavor || "",
      txHash: null,
    };
  }

  const pilFlavor = getLicensePilFlavor(template.licenseType);
  // Upload detailed terms to R2 so Story points to the creator's customized terms.
  const termsPayload = {
    type: "macadam-sound-license-template",
    licenseType: template.licenseType,
    price: template.price,
    currency: template.currency || "USD",
    usageRights: template.usageRights || {},
    territory: template.territory || "worldwide",
    territoryNotes: template.territoryNotes || "",
    durationType: template.durationType || "perpetual",
    durationDays: template.durationDays || null,
    exclusivity: Boolean(template.exclusivity),
    attributionRequired: Boolean(template.attributionRequired),
    legalText: template.legalText || "",
    storyFoundationId: template.storyFoundationId || "",
    templateId: String(template._id),
    updatedAt: new Date().toISOString(),
  };

  const buf = Buffer.from(JSON.stringify(termsPayload, null, 2), "utf8");
  const key = `ip/${template.creator}/sounds/${template.sound}/license-terms-${template.licenseType}.json`;
  const uploaded = await uploadToR2(buf, key, "application/json");
  template.storyTermsUri = uploaded.fileUrl;

  const terms = buildPilTermsFromTemplate({ template, uri: uploaded.fileUrl });
  const resp = await client.license.registerPILTerms(terms);

  const licenseTermsId =
    resp?.licenseTermsId != null ? String(resp.licenseTermsId) : "";
  if (!licenseTermsId) {
    throw new Error("Failed to register Story license terms");
  }

  template.storyLicenseTermsId = licenseTermsId;
  template.storyPilFlavor = pilFlavor;
  await template.save();

  return {
    licenseTermsId,
    pilFlavor,
    txHash: resp?.txHash || null,
  };
}

/**
 * Mint a Story license token for an IP (sound).
 *
 * Notes:
 * - The platform Story wallet is the IP owner (it minted/registered the IP), so it can mint
 *   using any license terms even if they are not attached publicly.
 */
async function mintStoryLicenseToken({
  ipId,
  template,
  receiver,
  amount = 1,
}) {
  if (!isEvmAddress(ipId)) throw new Error("Invalid ipId");
  if (!isEvmAddress(receiver)) throw new Error("Invalid receiver address");

  const { privateKey, chainId, rpcUrl } = getOnChainLicenseConfig();
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);

  const client = StoryClient.newClientUseAccount({
    account,
    chainId,
    transport,
  });

  const { licenseTermsId } = await ensureLicenseTermsForTemplate({
    template,
    client,
  });

  const mintResp = await client.license.mintLicenseTokens({
    licensorIpId: ipId,
    licenseTermsId,
    receiver,
    amount,
    maxMintingFee: 0, // do not pay mint fees
  });

  const tokenIds = Array.isArray(mintResp?.licenseTokenIds)
    ? mintResp.licenseTokenIds.map((x) => String(x))
    : [];

  return {
    licenseTermsId,
    txHash: mintResp?.txHash || "",
    licenseTokenIds: tokenIds,
  };
}

async function publishTemplateToStory({ ipId, template }) {
  if (!isEvmAddress(ipId)) throw new Error("Invalid ipId");
  if (!template) throw new Error("Template is required");

  const { privateKey, chainId, rpcUrl } = getOnChainLicenseConfig();
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);

  const client = StoryClient.newClientUseAccount({
    account,
    chainId,
    transport,
  });

  const { licenseTermsId } = await ensureLicenseTermsForTemplate({
    template,
    client,
  });

  const attachResp = await client.license.attachLicenseTerms({
    ipId,
    licenseTermsId,
  });

  template.storyLicenseAttached = Boolean(attachResp?.success);
  template.storyAttachTxHash = attachResp?.txHash || "";
  await template.save();

  // Optional: enforce exclusivity by limiting max tokens on-chain
  if (template.licenseType === "exclusive_buyout" || template.exclusivity === true) {
    try {
      await client.license.setMaxLicenseTokens({
        ipId,
        licenseTermsId,
        maxLicenseTokens: 1,
      });
    } catch {
      // best-effort
    }
  }

  return {
    licenseTermsId,
    attachTxHash: attachResp?.txHash || "",
    attached: Boolean(attachResp?.success),
    termsUri: template.storyTermsUri || "",
  };
}

module.exports = {
  mintStoryLicenseToken,
  isEvmAddress,
  publishTemplateToStory,
};

