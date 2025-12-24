const { http, createPublicClient, formatEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

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

async function getStoryWalletStatus() {
  const privateKey = normalizePrivateKey(process.env.STORY_ONCHAIN_PRIVATE_KEY);
  const chainId = Number(process.env.STORY_ONCHAIN_CHAIN_ID || 1315);
  const rpcUrl = process.env.STORY_ONCHAIN_RPC_URL || "https://aeneid.storyrpc.io";

  if (!privateKey) {
    throw new Error(
      "STORY_ONCHAIN_PRIVATE_KEY is missing/invalid (must be 64 hex chars, optionally prefixed with 0x)"
    );
  }

  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({
    transport,
    chain: {
      id: chainId,
      name: "Story",
      nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
  });

  const balanceWei = await publicClient.getBalance({ address: account.address });
  const balanceIP = formatEther(balanceWei);

  return {
    address: account.address,
    chainId,
    rpcUrl,
    balanceWei: balanceWei.toString(),
    balanceIP,
  };
}

module.exports = {
  getStoryWalletStatus,
};

