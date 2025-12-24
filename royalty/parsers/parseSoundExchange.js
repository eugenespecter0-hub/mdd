const fs = require("fs");
const csv = require("csv-parser");

/**
 * Parse SoundExchange royalty report
 * Matches by ISRC and returns JSON
 */
async function parseSoundExchange(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // SoundExchange CSV format typically includes:
        // ISRC, Performance Title, Featured Artist, Royalty Amount, etc.
        const record = {
          isrc: (row.ISRC || row.isrc || row["ISRC Code"] || "").toString().toUpperCase(),
          performanceTitle: row["Performance Title"] || row.Performance_Title || row.performance_title || "",
          featuredArtist: row["Featured Artist"] || row.Featured_Artist || row.featured_artist || "",
          royaltyAmount: parseFloat(row["Royalty Amount"] || row.Royalty_Amount || row.royalty_amount || 0),
          performanceCount: parseInt(row["Performance Count"] || row.Performance_Count || row.performance_count || 0),
          period: row.Period || row.period || row["Statement Period"] || "",
          service: row.Service || row.service || row["Service Name"] || "",
          currency: row.Currency || row.currency || "USD",
        };

        if (record.isrc) {
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

module.exports = { parseSoundExchange };

