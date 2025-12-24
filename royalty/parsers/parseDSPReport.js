const fs = require("fs");
const csv = require("csv-parser");
const xml2js = require("xml2js");

/**
 * Parse DSP (Digital Service Provider) royalty report
 * Supports XML and CSV formats
 * Matches by ISRC and returns JSON
 */
async function parseDSPReport(filePath, fileType) {
  try {
    if (fileType === "csv" || filePath.endsWith(".csv")) {
      return await parseCSVReport(filePath);
    } else if (fileType === "xml" || filePath.endsWith(".xml")) {
      return await parseXMLReport(filePath);
    } else {
      throw new Error("Unsupported file type. Only CSV and XML are supported.");
    }
  } catch (error) {
    console.error("Error parsing DSP report:", error);
    throw error;
  }
}

/**
 * Parse CSV format DSP report
 */
async function parseCSVReport(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // Common CSV columns: ISRC, Title, Artist, Streams, Revenue, etc.
        const record = {
          isrc: row.ISRC || row.isrc || row.ISRC_Code || "",
          title: row.Title || row.title || row.Track_Title || "",
          artist: row.Artist || row.artist || row.Artist_Name || "",
          streams: parseInt(row.Streams || row.streams || row.Stream_Count || 0),
          revenue: parseFloat(row.Revenue || row.revenue || row.Amount || 0),
          platform: row.Platform || row.platform || row.Service || "",
          period: row.Period || row.period || row.Date || "",
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

/**
 * Parse XML format DSP report
 */
async function parseXMLReport(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        reject(err);
        return;
      }

      const parser = new xml2js.Parser();
      parser.parseString(data, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const records = [];
        
        // Handle different XML structures
        // Common structures: root.records.record[], root.tracks.track[], etc.
        const extractRecords = (obj, path = []) => {
          if (Array.isArray(obj)) {
            obj.forEach((item) => extractRecords(item, path));
          } else if (typeof obj === "object" && obj !== null) {
            // Look for ISRC field
            if (obj.ISRC || obj.isrc || obj.ISRC_Code) {
              records.push({
                isrc: (obj.ISRC || obj.isrc || obj.ISRC_Code || "").toString().toUpperCase(),
                title: (obj.Title || obj.title || obj.Track_Title || "").toString(),
                artist: (obj.Artist || obj.artist || obj.Artist_Name || "").toString(),
                streams: parseInt(obj.Streams || obj.streams || obj.Stream_Count || 0),
                revenue: parseFloat(obj.Revenue || obj.revenue || obj.Amount || 0),
                platform: (obj.Platform || obj.platform || obj.Service || "").toString(),
                period: (obj.Period || obj.period || obj.Date || "").toString(),
                currency: (obj.Currency || obj.currency || "USD").toString(),
              });
            } else {
              // Recursively search
              Object.keys(obj).forEach((key) => {
                extractRecords(obj[key], [...path, key]);
              });
            }
          }
        };

        extractRecords(result);
        resolve(records);
      });
    });
  });
}

module.exports = { parseDSPReport };

