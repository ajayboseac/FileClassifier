// =============================================================================
// DUPLICATE FILE DETECTION
// Prevents re-processing of files that have already been classified.
// Uses a Duplicate_Registry sheet to track every processed file by
// File ID and MD5 content hash.
// =============================================================================

/**
 * Gets or creates the Duplicate_Registry sheet in the destination root folder.
 * Returns { sheet: Sheet, data: Array<Object> } where data contains all
 * previously registered file entries.
 */
function getOrCreateDuplicateRegistry(rootDestFolder) {
  var sheetName = "Duplicate_Registry";
  var sheetFile;
  var files = rootDestFolder.getFilesByName(sheetName);

  if (files.hasNext()) {
    sheetFile = files.next();
  } else {
    // Create the registry sheet with headers
    var ss = SpreadsheetApp.create(sheetName);
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "File ID", "MD5 Hash", "Original Name", "Category",
      "Patient Name", "Document Date", "Claim Folder",
      "Processed At", "Bill Number"
    ]);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold");
    sheet.setFrozenRows(1);

    // Move to root destination folder
    var file = DriveApp.getFileById(ss.getId());
    file.moveTo(rootDestFolder);
    sheetFile = file;

    Logger.log("Created new Duplicate_Registry sheet.");
    return { sheet: ss.getSheets()[0], data: [] };
  }

  // Load existing data into an array of objects
  var ss = SpreadsheetApp.openById(sheetFile.getId());
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  var data = [];

  if (lastRow > 1) {
    var rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    for (var i = 0; i < rows.length; i++) {
      data.push({
        fileId: rows[i][0],
        md5Hash: rows[i][1],
        originalName: rows[i][2],
        category: rows[i][3],
        patientName: rows[i][4],
        documentDate: rows[i][5],
        claimFolder: rows[i][6],
        processedAt: rows[i][7],
        billNumber: rows[i][8]
      });
    }
  }

  Logger.log("Loaded Duplicate_Registry with " + data.length + " entries.");
  return { sheet: sheet, data: data };
}

// =============================================================================
// MD5 HASH RETRIEVAL
// =============================================================================

/**
 * Gets the MD5 hash of a file.
 * - For uploaded/binary files: uses Drive API's built-in md5Checksum.
 * - For Google-native files (Docs, Sheets): computes hash from exported text.
 * Returns the MD5 hex string, or null if unable to compute.
 */
function getFileMD5(file) {
  try {
    // Try the Advanced Drive Service first — gives MD5 for non-native files
    var driveFile = Drive.Files.get(file.getId(), { fields: "md5Checksum" });
    if (driveFile.md5Checksum) {
      return driveFile.md5Checksum;
    }
  } catch (e) {
    Logger.log("  -> Drive.Files.get failed for MD5: " + e.toString());
  }

  // Fallback for Google-native files (Docs, Sheets, etc.) — compute from content
  try {
    var mimeType = file.getMimeType();
    var content;

    if (mimeType === MimeType.GOOGLE_DOCS) {
      content = DocumentApp.openById(file.getId()).getBody().getText();
    } else if (mimeType === MimeType.GOOGLE_SHEETS) {
      // Export as CSV for hashing
      var blob = file.getBlob();
      content = blob.getDataAsString();
    } else {
      // Try getting blob content
      var blob = file.getBlob();
      var bytes = blob.getBytes();
      var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
      return digestToHex(digest);
    }

    if (content) {
      var digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.MD5,
        content,
        Utilities.Charset.UTF_8
      );
      return digestToHex(digest);
    }
  } catch (e) {
    Logger.log("  -> Fallback MD5 computation failed: " + e.toString());
  }

  return null;
}

/**
 * Converts a byte array digest to a hex string.
 */
function digestToHex(digest) {
  return digest.map(function(byte) {
    var hex = (byte < 0 ? byte + 256 : byte).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

// =============================================================================
// DUPLICATE DETECTION
// =============================================================================

/**
 * Checks if a file is a duplicate of something already processed.
 * Uses a 3-layer approach:
 *   Layer 1: Exact File ID match (already processed this exact file)
 *   Layer 2: MD5 content hash match (same content, different file)
 *   Layer 3: Filename pattern match (re-upload patterns like "file (1).pdf")
 *
 * Returns: { isDuplicate: boolean, reason: string, existingEntry: Object|null }
 */
function isDuplicate(file, registryData) {
  var fileId = file.getId();
  var fileName = file.getName();

  // ── LAYER 1: File ID Match ──
  // If this exact Drive file has been processed before
  for (var i = 0; i < registryData.length; i++) {
    if (registryData[i].fileId === fileId) {
      return {
        isDuplicate: true,
        reason: "Already processed (same File ID)",
        existingEntry: registryData[i]
      };
    }
  }

  // ── LAYER 2: MD5 Content Hash Match ──
  var md5 = getFileMD5(file);
  if (md5) {
    for (var i = 0; i < registryData.length; i++) {
      if (registryData[i].md5Hash === md5) {
        return {
          isDuplicate: true,
          reason: "Identical content (MD5: " + md5.substring(0, 8) + "…) — " +
                  "matches '" + registryData[i].originalName + "'",
          existingEntry: registryData[i]
        };
      }
    }
  }

  // ── LAYER 3: Filename Pattern Match ──
  // Detect common re-upload patterns:
  //   "report (1).pdf" → "report.pdf"
  //   "Copy of report.pdf" → "report.pdf"
  var normalizedName = normalizeFileName(fileName);
  for (var i = 0; i < registryData.length; i++) {
    var existingNormalized = normalizeFileName(registryData[i].originalName);
    if (normalizedName === existingNormalized && normalizedName.length > 0) {
      // Same normalized name — this is a SOFT match.
      // Only flag as duplicate if MD5 also matched (already caught above),
      // or if we couldn't get MD5. Log a warning either way.
      if (!md5) {
        return {
          isDuplicate: true,
          reason: "Likely re-upload (filename pattern match: '" +
                  registryData[i].originalName + "') — MD5 unavailable for confirmation",
          existingEntry: registryData[i]
        };
      }
      // If MD5 was available but didn't match, the content differs.
      // This is NOT a duplicate — just a similar name. Log for awareness.
      Logger.log("  -> NOTE: Similar filename to '" + registryData[i].originalName +
                 "' but content differs (MD5 mismatch). Processing normally.");
    }
  }

  // Store the MD5 for later registration
  return {
    isDuplicate: false,
    reason: null,
    existingEntry: null,
    md5Hash: md5
  };
}

/**
 * Normalizes a filename for pattern matching.
 * Strips common re-upload artifacts:
 *   - " (1)", " (2)", etc.
 *   - "Copy of "
 *   - Leading/trailing whitespace
 *   - Case
 */
function normalizeFileName(name) {
  if (!name) return "";
  return name
    .replace(/^Copy of\s+/i, "")      // "Copy of report.pdf" → "report.pdf"
    .replace(/\s*\(\d+\)/g, "")        // "report (1).pdf" → "report.pdf"
    .replace(/\s*-\s*\d+(?=\.\w+$)/, "")  // "report-1.pdf" → "report.pdf"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// =============================================================================
// DUPLICATE HANDLING
// =============================================================================

/**
 * Handles a detected duplicate file:
 * 1. Moves it to a _duplicates/ subfolder (safe — not deleted)
 * 2. Logs the duplicate to Duplicate_Log sheet
 */
function handleDuplicate(file, rootDestFolder, dupCheck) {
  // 1. Get or create the _duplicates folder
  var dupFolderName = "_duplicates";
  var dupFolder;
  var folders = rootDestFolder.getFoldersByName(dupFolderName);
  if (folders.hasNext()) {
    dupFolder = folders.next();
  } else {
    dupFolder = rootDestFolder.createFolder(dupFolderName);
    Logger.log("Created _duplicates folder.");
  }

  // 2. Move the file to _duplicates (preserving the original name)
  var originalName = file.getName();
  file.moveTo(dupFolder);
  Logger.log("  -> Moved duplicate '" + originalName + "' to _duplicates/");

  // 3. Log the duplicate
  logDuplicate(rootDestFolder, originalName, file.getId(), dupCheck);
}

/**
 * Logs a duplicate detection event to the Duplicate_Log sheet.
 */
function logDuplicate(rootDestFolder, originalName, fileId, dupCheck) {
  var logSheetName = "Duplicate_Log";
  var logFile;
  var files = rootDestFolder.getFilesByName(logSheetName);

  if (files.hasNext()) {
    logFile = files.next();
  } else {
    // Create the log sheet
    var ss = SpreadsheetApp.create(logSheetName);
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "Timestamp", "Duplicate File Name", "Duplicate File ID",
      "Reason", "Original File Name", "Original Claim Folder",
      "Original Category", "Original Processed At"
    ]);
    sheet.getRange(1, 1, 1, 8).setFontWeight("bold");
    sheet.setFrozenRows(1);

    var file = DriveApp.getFileById(ss.getId());
    file.moveTo(rootDestFolder);
    logFile = file;

    Logger.log("Created Duplicate_Log sheet.");
  }

  var ss = SpreadsheetApp.openById(logFile.getId());
  var sheet = ss.getSheets()[0];

  var existing = dupCheck.existingEntry || {};
  sheet.appendRow([
    new Date(),
    originalName,
    fileId,
    dupCheck.reason || "Unknown",
    existing.originalName || "",
    existing.claimFolder || "",
    existing.category || "",
    existing.processedAt || ""
  ]);
}

// =============================================================================
// FILE REGISTRATION
// =============================================================================

/**
 * Registers a successfully processed file in the Duplicate_Registry.
 * Call this AFTER the file has been classified, moved, and logged.
 */
function registerProcessedFile(registrySheet, data) {
  registrySheet.appendRow([
    data.fileId || "",
    data.md5Hash || "",
    data.fileName || "",
    data.category || "",
    data.patientName || "",
    data.documentDate || "",
    data.claimFolderName || "",
    new Date(),
    data.billNumber || ""
  ]);
}
