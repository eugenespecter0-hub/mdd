const crypto = require("crypto");
const { StoryClient } = require("@story-protocol/core-sdk");
const { http, createPublicClient } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return "";
  }
  return key;
}

function sha256Hex32(buffer) {
  const hex = crypto.createHash("sha256").update(buffer).digest("hex");
  return `0x${hex}`;
}

function getOnChainConfig() {
  const privateKeyRaw = process.env.STORY_ONCHAIN_PRIVATE_KEY;
  const privateKey = normalizePrivateKey(privateKeyRaw);
  const spgNftContract = process.env.STORY_SPG_NFT_CONTRACT;
  const chainId = Number(process.env.STORY_ONCHAIN_CHAIN_ID || 1315); // Story Aeneid default
  const rpcUrl = process.env.STORY_ONCHAIN_RPC_URL || "https://aeneid.storyrpc.io";

  const missing = [];
  if (!privateKey) {
    missing.push(
      "STORY_ONCHAIN_PRIVATE_KEY (must be 64 hex chars, optionally prefixed with 0x; no spaces)"
    );
  }
  if (!spgNftContract) missing.push("STORY_SPG_NFT_CONTRACT (or create it via POST /api/sounds/story/create-spg)");
  if (missing.length > 0) {
    throw new Error(`Story on-chain registration not configured (missing: ${missing.join(", ")})`);
  }

  return { privateKey, spgNftContract, chainId, rpcUrl };
}

function getExplorerBase(chainId) {
  // Aeneid default; can be overridden if needed later
  if (chainId === 1315) return "https://aeneid.storyscan.io";
  return "";
}

/**
 * Register a sound as a Story IP asset on-chain.
 *
 * Returns a "proof" object you can store in DB + later export to JSON.
 */
async function registerSoundOnChain({ fileHash, fileUrl, metadata }) {
  const { privateKey, spgNftContract, chainId, rpcUrl } = getOnChainConfig();

  const creatorUserId = metadata?.creatorUserId ? String(metadata.creatorUserId) : "";
  const platformSoundId = metadata?.platformSoundId ? String(metadata.platformSoundId) : "";
  if (!creatorUserId || !platformSoundId) {
    throw new Error("Missing metadata.creatorUserId or metadata.platformSoundId for on-chain registration");
  }

  const ipMetadata = {
    assetType: "sound",
    title: metadata?.title || "",
    description: metadata?.description || "",
    creator: metadata?.creator || "",
    uploadDate: metadata?.uploadDate || new Date().toISOString(),
    creatorUserId,
    platformSoundId,
    fileHash,
    fileUrl,
  };

  const ipMetadataBuf = Buffer.from(JSON.stringify(ipMetadata, null, 2), "utf8");
  const ipMetadataHash = sha256Hex32(ipMetadataBuf);

  const ipMetadataUpload = await uploadToR2(
    ipMetadataBuf,
    `ip/${creatorUserId}/sounds/${platformSoundId}/story-ip-metadata.json`,
    "application/json"
  );

  // NFT metadata can be the same JSON for now
  const nftMetadataBuf = ipMetadataBuf;
  const nftMetadataHash = ipMetadataHash;
  const nftMetadataURI = ipMetadataUpload.fileUrl;

  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);

  const client = StoryClient.newClientUseAccount({
    account,
    chainId,
    transport,
  });

  const result = await client.ipAsset.registerIpAsset({
    nft: {
      type: "mint",
      spgNftContract,
      recipient: account.address,
      allowDuplicates: true,
    },
    ipMetadata: {
      ipMetadataURI: ipMetadataUpload.fileUrl,
      ipMetadataHash,
      nftMetadataURI,
      nftMetadataHash,
    },
  });

  const txHash = result?.txHash || null;
  const ipId = result?.ipId || null;
  const tokenId = result?.tokenId != null ? String(result.tokenId) : null;

  // Best-effort receipt (for block timestamp later if needed)
  let receipt = result?.receipt || null;
  try {
    if (!receipt && txHash) {
      const publicClient = createPublicClient({
        transport,
        chain: {
          id: chainId,
          name: "Story",
          nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
        },
      });
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    }
  } catch {
    // ignore
  }

  const timestamp = new Date().toISOString();
  const explorer = getExplorerBase(chainId);

  const proof = {
    type: "story-onchain",
    chainId,
    rpcUrl,
    txHash,
    ipId,
    tokenId,
    receipt: receipt
      ? {
          blockNumber: receipt.blockNumber?.toString?.() || String(receipt.blockNumber),
          transactionHash: receipt.transactionHash,
          status: receipt.status,
        }
      : null,
    explorer: explorer
      ? {
          txUrl: txHash ? `${explorer}/tx/${txHash}` : null,
          ipUrl: ipId ? `${explorer}/address/${ipId}` : null,
        }
      : null,
    metadata: {
      ...ipMetadata,
      ipMetadataURI: ipMetadataUpload.fileUrl,
      ipMetadataHash,
      nftMetadataURI,
      nftMetadataHash,
    },
  };

  return {
    storyFoundationId: ipId || "",
    timestamp,
    proof,
    raw: result,
  };
}

module.exports = {
  registerSoundOnChain,
};

