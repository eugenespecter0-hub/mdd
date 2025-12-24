/**
 * License PDF Generator
 * Uses PDFKit to generate license PDFs
 */

const PDFDocument = require("pdfkit");
const { uploadToR2 } = require("./cloudflareR2");

/**
 * Generate license PDF
 * @param {Object} license - License document
 * @param {Object} track - Track document
 * @param {Object} buyer - Buyer user document
 * @param {Object} creator - Creator user document
 * @param {Object} licenseType - License type document
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateLicensePDF(license, track, buyer, creator, licenseType) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      });

      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on("error", reject);

      // Header
      doc
        .fontSize(24)
        .font("Helvetica-Bold")
        .text("MACADAM CO.", { align: "center" })
        .moveDown();

      doc
        .fontSize(18)
        .font("Helvetica")
        .text("MUSIC LICENSE AGREEMENT", { align: "center" })
        .moveDown(2);

      // License Information
      doc.fontSize(12).font("Helvetica-Bold").text("License Number:");
      doc.font("Helvetica").text(license.licenseNumber);
      doc.moveDown();

      doc.font("Helvetica-Bold").text("License Type:");
      doc.font("Helvetica").text(licenseType.displayName);
      doc.moveDown();

      doc.font("Helvetica-Bold").text("Issue Date:");
      doc.font("Helvetica").text(license.createdAt.toLocaleDateString());
      doc.moveDown(2);

      // Track Information
      doc.fontSize(14).font("Helvetica-Bold").text("LICENSED TRACK");
      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica");
      doc.text(`Title: ${track.title}`);
      doc.text(`Artist: ${track.artist}`);
      if (track.album) doc.text(`Album: ${track.album}`);
      if (track.isrc) doc.text(`ISRC: ${track.isrc}`);
      doc.moveDown();

      // Parties
      doc.fontSize(14).font("Helvetica-Bold").text("LICENSOR (CREATOR)");
      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica");
      doc.text(`Name: ${creator.userName || creator.email}`);
      if (creator.firstName || creator.lastName) {
        doc.text(
          `Full Name: ${creator.firstName || ""} ${creator.lastName || ""}`.trim()
        );
      }
      doc.moveDown();

      doc.fontSize(14).font("Helvetica-Bold").text("LICENSEE (BUYER)");
      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica");
      doc.text(`Name: ${buyer.userName || buyer.email}`);
      if (buyer.firstName || buyer.lastName) {
        doc.text(
          `Full Name: ${buyer.firstName || ""} ${buyer.lastName || ""}`.trim()
        );
      }
      doc.text(`Email: ${buyer.email}`);
      doc.moveDown(2);

      // License Terms
      doc.fontSize(14).font("Helvetica-Bold").text("LICENSE TERMS");
      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica");
      doc.text(licenseType.description, { align: "justify" });
      doc.moveDown();

      doc.font("Helvetica-Bold").text("Allowed Uses:");
      doc.font("Helvetica").text(licenseType.allowedUses);
      doc.moveDown();

      if (licenseType.restrictions && licenseType.restrictions.length > 0) {
        doc.font("Helvetica-Bold").text("Restrictions:");
        licenseType.restrictions.forEach((restriction) => {
          doc.font("Helvetica").text(`• ${restriction}`);
        });
        doc.moveDown();
      }

      // Payment Information
      doc.fontSize(14).font("Helvetica-Bold").text("PAYMENT INFORMATION");
      doc.moveDown(0.5);
      doc.fontSize(12).font("Helvetica");
      doc.text(`Amount Paid: $${licenseType.price.toFixed(2)} ${licenseType.currency}`);
      doc.text(`Payment Intent ID: ${license.stripePaymentIntentId}`);
      doc.moveDown(2);

      // License JSON CID (IPFS)
      if (license.licenseJsonCid) {
        doc.fontSize(12).font("Helvetica-Bold").text("IPFS CID:");
        doc.font("Helvetica").text(license.licenseJsonCid);
        doc.moveDown();
      }

      // Footer
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(
          "This license is governed by the terms and conditions of Macadam Co.",
          { align: "center" }
        )
        .moveDown();
      doc
        .text(
          `Generated on ${new Date().toLocaleString()}`,
          { align: "center" }
        );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate and upload license PDF
 * @param {Object} license - License document
 * @param {Object} track - Track document
 * @param {Object} buyer - Buyer user document
 * @param {Object} creator - Creator user document
 * @param {Object} licenseType - License type document
 * @returns {Promise<Object>} Upload result with URL and storage key
 */
async function generateAndUploadLicensePDF(
  license,
  track,
  buyer,
  creator,
  licenseType
) {
  const pdfBuffer = await generateLicensePDF(
    license,
    track,
    buyer,
    creator,
    licenseType
  );

  const fileName = `license-${license.licenseNumber}-${Date.now()}.pdf`;
  const uploadResult = await uploadToR2(
    pdfBuffer,
    fileName,
    "application/pdf",
    "license-pdfs"
  );

  return uploadResult;
}

module.exports = {
  generateLicensePDF,
  generateAndUploadLicensePDF,
};
