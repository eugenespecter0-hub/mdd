# Cloudflare R2 Configuration

This utility handles file uploads to Cloudflare R2 (S3-compatible storage).

## Required Environment Variables

Add these to your `.env` file:

```env
# Cloudflare R2 Configuration
CLOUDFLARE_R2_ACCESS_KEY_ID=your_access_key_id
CLOUDFLARE_R2_SECRET_ACCESS_KEY=your_secret_access_key
CLOUDFLARE_R2_BUCKET_NAME=your_bucket_name
CLOUDFLARE_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_R2_PUBLIC_URL=https://your-custom-domain.com
```

## Getting Your Cloudflare R2 Credentials

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **R2** → **Manage R2 API Tokens**
3. Create a new API token with read/write permissions
4. Copy the **Access Key ID** and **Secret Access Key**
5. Get your **Account ID** from the R2 dashboard
6. Your endpoint will be: `https://<account-id>.r2.cloudflarestorage.com`

## Public URL Setup

You can either:
- Use a custom domain (recommended): Set `CLOUDFLARE_R2_PUBLIC_URL` to your custom domain
- Use R2's public URL: Leave `CLOUDFLARE_R2_PUBLIC_URL` empty and it will use `https://pub-<account-id>.r2.dev`

## Making Your R2 Bucket Public

1. Go to your R2 bucket settings
2. Enable **Public Access**
3. Configure CORS if needed for direct browser uploads


