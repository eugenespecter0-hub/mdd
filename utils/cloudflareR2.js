require("dotenv").config();
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Cloudflare R2 is S3-compatible, so we use AWS SDK
const s3Client = new S3Client({
  region: "auto",
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // e.g., https://<account-id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET_NAME;
const PUBLIC_URL = process.env.CLOUDFLARE_R2_PUBLIC_URL; // Your custom domain or R2 public URL

console.log("R2 KEY:", process.env.R2_ACCESS_KEY_ID);
console.log("R2 SECRET:", process.env.R2_SECRET_ACCESS_KEY);

/**
 * Upload a file to Cloudflare R2
 * @param {Buffer} fileBuffer - The file buffer to upload
 * @param {string} fileName - The original file name
 * @param {string} mimeType - The MIME type of the file
 * @param {string} folder - The folder path in R2 (e.g., 'audio', 'thumbnails')
 * @returns {Promise<{fileUrl: string, storageKey: string}>}
 */
async function uploadToR2(fileBuffer, fileName, mimeType, folder = "uploads") {
  try {
    // Generate a unique file name to avoid conflicts
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = fileName.split(".").pop();
    const sanitizedFileName = fileName
      .replace(/[^a-zA-Z0-9.-]/g, "_")
      .toLowerCase();
    const uniqueFileName = `${timestamp}-${randomString}-${sanitizedFileName}`;
    const storageKey = `${folder}/${uniqueFileName}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storageKey,
      Body: fileBuffer,
      ContentType: mimeType,
      // Make file publicly accessible (optional, adjust based on your needs)
      // ACL: "public-read", // R2 doesn't use ACL, use public URL instead
    });

    await s3Client.send(command);

    // Construct the public URL
    // If you have a custom domain: https://yourdomain.com/folder/filename
    // Or use R2 public URL: https://pub-<account-id>.r2.dev/folder/filename
    const fileUrl = PUBLIC_URL
      ? `${PUBLIC_URL}/${storageKey}`
      : `https://pub-${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.dev/${storageKey}`;

    return {
      fileUrl,
      storageKey,
      fileName: uniqueFileName,
    };
  } catch (error) {
    console.error("Error uploading to Cloudflare R2:", error);
    throw new Error(`Failed to upload file to R2: ${error.message}`);
  }
}

module.exports = {
  uploadToR2,
  s3Client,
};

