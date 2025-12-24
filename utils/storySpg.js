const { StoryClient } = require("@story-protocol/core-sdk");
const { http, createPublicClient } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { uploadToR2 } = require("./cloudflareR2");

function normalizePrivateKey(input) {
  if (!input) return "";
  let key = String(input).trim();
  // Strip wrapping quotes if user pasted into .env like "0x..."
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (key && !key.startsWith("0x")) key = `0x${key}`;
  // Expect 32-byte hex: 0x + 64 hex chars
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return "";
  }
  return key;
}

function getSpgConfig() {
  const privateKeyRaw = process.env.STORY_ONCHAIN_PRIVATE_KEY;
  const privateKey = normalizePrivateKey(privateKeyRaw);
  const chainId = Number(process.env.STORY_ONCHAIN_CHAIN_ID || 1315);
  const rpcUrl = process.env.STORY_ONCHAIN_RPC_URL || "https://aeneid.storyrpc.io";

  const missing = [];
  if (!privateKey) {
    missing.push(
      "STORY_ONCHAIN_PRIVATE_KEY (must be 64 hex chars, optionally prefixed with 0x; no spaces)"
    );
  }
  if (missing.length > 0) {
    throw new Error(`Story on-chain config missing: ${missing.join(", ")}`);
  }

  return { privateKey, chainId, rpcUrl };
}

/**
 * Creates an SPG NFT Collection on Story (Aeneid by default).
 * Stores a small contractURI JSON on R2 and points the contract to it.
 */
async function createSpgCollection({ name, symbol, ownerAddress, mintFeeRecipient }) {
  const { privateKey, chainId, rpcUrl } = getSpgConfig();
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);

  const client = StoryClient.newClientUseAccount({
    account,
    chainId,
    transport,
  });

  const owner = ownerAddress || account.address;
  const feeRecipient = mintFeeRecipient || account.address;

  const contractMeta = {
    name: name || "MacAdam SPG",
    description: "MacAdam Sound IP registrations (SPG NFT collection)",
    image: "",
    external_link: "",
    createdAt: new Date().toISOString(),
    chainId,
    owner,
  };

  const contractUriUpload = await uploadToR2(
    Buffer.from(JSON.stringify(contractMeta, null, 2), "utf8"),
    `ip/story/spg/${chainId}/${Date.now()}-contract-uri.json`,
    "application/json"
  );

  const result = await client.nftClient.createNFTCollection({
    name: name || "MacAdam SPG",
    symbol: symbol || "MACSPG",
    isPublicMinting: false, // only platform wallet mints
    mintOpen: true,
    mintFeeRecipient: feeRecipient,
    contractURI: contractUriUpload.fileUrl,
    owner,
  });

  // best-effort receipt
  let receipt = null;
  try {
    if (result?.txHash) {
      const publicClient = createPublicClient({
        transport,
        chain: {
          id: chainId,
          name: "Story",
          nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
        },
      });
      receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash });
    }
  } catch {
    // ignore
  }

  return {
    spgNftContract: result?.spgNftContract || "",
    txHash: result?.txHash || "",
    chainId,
    rpcUrl,
    owner,
    mintFeeRecipient: feeRecipient,
    contractURI: contractUriUpload.fileUrl,
    receipt: receipt
      ? {
          blockNumber: receipt.blockNumber?.toString?.() || String(receipt.blockNumber),
          transactionHash: receipt.transactionHash,
          status: receipt.status,
        }
      : null,
  };
}

module.exports = {
  createSpgCollection,
};

