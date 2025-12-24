const fs = require("fs");
const csv = require("csv-parser");

/**
 * Parse YouTube Content ID (CID) CSV report
 * Matches by asset ID and returns JSON
 */
async function parseYouTubeCID(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // YouTube CID CSV columns vary, but typically include:
        // Asset ID, Asset Title, Asset Type, Views, Revenue, etc.
        const record = {
          assetId: row["Asset ID"] || row.Asset_ID || row.asset_id || row["Asset ID"] || "",
          assetTitle: row["Asset Title"] || row.Asset_Title || row.asset_title || "",
          assetType: row["Asset Type"] || row.Asset_Type || row.asset_type || "",
          views: parseInt(row.Views || row.views || row.View_Count || 0),
          revenue: parseFloat(row.Revenue || row.revenue || row.Amount || 0),
          period: row.Period || row.period || row.Date || row["Reporting Date"] || "",
          currency: row.Currency || row.currency || "USD",
          // YouTube-specific fields
          videoId: row["Video ID"] || row.Video_ID || row.video_id || "",
          channelId: row["Channel ID"] || row.Channel_ID || row.channel_id || "",
          claimType: row["Claim Type"] || row.Claim_Type || row.claim_type || "",
        };

        if (record.assetId || record.videoId) {
          results.push(record);
        }
      })
      .on("end", () => {
        resolve(results);
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

module.exports = { parseYouTubeCID };

