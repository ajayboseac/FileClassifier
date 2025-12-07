/**
 * Main function to process files.
 * Set this up with a Time-driven trigger (e.g., every 15 mins).
 */
function processFiles() {
  var sourceFolder = DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID);
  var destFolder = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID);
  
  // 1. Get Existing Claims Metadata
  var existingClaims = getExistingClaimsMetadata(destFolder);
  
  // 2. Extract Metadata for ALL new files
  var fileDataList = [];
  var files = sourceFolder.getFiles();
  
  while (files.hasNext()) {
    var file = files.next();
    Logger.log("Processing file: " + file.getName());
    
    try {
      var text = extractText(file);
      if (!text || text.length < 10) {
        Logger.log("  -> Not enough text found. Skipping.");
        continue;
      }
      
      var metadata = callLLM(text);
      if (metadata) {
        metadata.fileId = file.getId();
        metadata.fileName = file.getName();
        // Ensure date is valid, else use today
        metadata.dateObj = parseDate(metadata.documentDate); 
        fileDataList.push(metadata);
      }
    } catch (e) {
      Logger.log("  -> Error processing file " + file.getName() + ": " + e.toString());
    }
  }
  
  // 3. Group and Assign Claims
  // Sort by date ascending to process chronological order
  fileDataList.sort(function(a, b) { return a.dateObj - b.dateObj; });
  
  for (var i = 0; i < fileDataList.length; i++) {
    var data = fileDataList[i];
    var assignedClaim = findMatchingClaim(data, existingClaims);
    
    if (assignedClaim) {
      data.claimFolderName = assignedClaim.folderName;
      // Update claim end date if this file is newer (conceptually, though we only track start for grouping)
    } else {
      // Create New Claim
      var newClaimName = generateClaimName(data);
      data.claimFolderName = newClaimName;
      
      // Add to existing claims so subsequent files in this batch can match it
      existingClaims.push({
        folderName: newClaimName,
        uhid: data.uhid,
        startDate: data.dateObj
      });
    }
    
    // 4. Move File & Update Sheet
    var file = DriveApp.getFileById(data.fileId);
    moveAndOrganizeFile(file, destFolder, data);
    updateConsolidatedSheet(destFolder, data);
  }
}

/**
 * Extracts text from a file (PDF or Image) using Google Drive's OCR.
 */
function extractText(file) {
  var mimeType = file.getMimeType();
  
  if (mimeType === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(file.getId()).getBody().getText();
  }
  
  var resource = {
    name: "Temp OCR Doc",
    mimeType: MimeType.GOOGLE_DOCS
  };
  
  // Drive API v3 uses 'ocrLanguage' in the request body or as a query parameter, 
  // but for Files.copy it's often passed as an optional argument.
  // Note: v3 'copy' method signature is (resource, fileId, optionalArgs)
  var options = {
    ocrLanguage: "en"
  };
  
  try {
    // Drive.Files.copy(resource, fileId, options)
    var tempFile = Drive.Files.copy(resource, file.getId(), options);
    var doc = DocumentApp.openById(tempFile.id);
    var text = doc.getBody().getText();
    Drive.Files.remove(tempFile.id); // GAS Advanced Service v3 still uses 'remove'
    return text;
  } catch (e) {
    Logger.log("  -> OCR Failed: " + e.toString());
    if (mimeType === MimeType.PLAIN_TEXT) {
      return file.getBlob().getDataAsString();
    }
    return null;
  }
}

/**
 * Calls Gemini API to classify the text.
 */
function callLLM(text) {
  var prompt = `
  You are a helpful assistant that organizes health insurance documents.
  
  Analyze the following document text and extract:
  1. Category: One of ["Prescription", "Consultation Bill", "Medicine Bill", "Diagnostics Bill", "Other"].
  2. UHID: The Unique Health ID or Patient ID. If not found, look for a mobile number or unique patient identifier. Return "Unknown" if absolutely not found.
  3. Document Date: The main date of the document in YYYY-MM-DD format. If not found, use today's date.
  4. Patient Name
  5. Clinic/Hospital Name
  6. Bill Number (if available)
  7. Amount (with currency)
  
  Return ONLY valid JSON.
  Example: { 
    "category": "Prescription", 
    "uhid": "123456789",
    "documentDate": "2025-01-20",
    "patientName": "Taps",
    "clinicName": "Apollo Hospital",
    "billNumber": "INV-123",
    "amount": "500 INR"
  }
  
  Document Text:
  ${text.substring(0, 3000)} 
  `;

  var url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL_NAME}:generateContent?key=${CONFIG.API_KEY}`;
  
  var payload = {
    contents: [{
      parts: [{ text: prompt }]
    }]
  };
  
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  var json = JSON.parse(response.getContentText());
  
  if (json.candidates && json.candidates[0] && json.candidates[0].content) {
    var responseText = json.candidates[0].content.parts[0].text;
    responseText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(responseText);
  }
  
  Logger.log("LLM Response Error: " + JSON.stringify(json));
  return null;
}

/**
 * Parses existing claim folders to build metadata list.
 * Folder Name Format: PatientName_UHID_YYYY-MM-DD
 */
function getExistingClaimsMetadata(rootFolder) {
  var claims = [];
  var folders = rootFolder.getFolders();
  
  while (folders.hasNext()) {
    var folder = folders.next();
    var name = folder.getName();
    var parts = name.split("_");
    
    // Expected format: Name_UHID_Date
    // But handle variations gracefully
    if (parts.length >= 3) {
      var dateStr = parts[parts.length - 1]; // Assume last part is date
      var uhid = parts[parts.length - 2];    // Assume second to last is UHID
      
      var dateObj = parseDate(dateStr);
      if (dateObj) {
        claims.push({
          folderName: name,
          uhid: uhid,
          startDate: dateObj
        });
      }
    }
  }
  return claims;
}

/**
 * Logic to find if a file belongs to an existing claim.
 * Match if: Same UHID AND FileDate is within 14 days of ClaimStartDate
 */
function findMatchingClaim(fileData, existingClaims) {
  if (!fileData.uhid || fileData.uhid === "Unknown") return null;
  
  // 14 days in milliseconds
  var TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  
  for (var i = 0; i < existingClaims.length; i++) {
    var claim = existingClaims[i];
    
    if (claim.uhid === fileData.uhid) {
      var diff = Math.abs(fileData.dateObj - claim.startDate);
      if (diff <= TWO_WEEKS_MS) {
        return claim;
      }
    }
  }
  return null;
}

/**
 * Generates a new claim folder name.
 * Format: PatientName_UHID_YYYY-MM-DD
 */
function generateClaimName(data) {
  var safeName = (data.patientName || "Unknown").replace(/[^a-zA-Z0-9]/g, "");
  var safeUHID = (data.uhid || "Unknown").replace(/[^a-zA-Z0-9]/g, "");
  var dateStr = data.documentDate || formatDate(new Date());
  
  return safeName + "_" + safeUHID + "_" + dateStr;
}

/**
 * Moves the file to the correct destination folder.
 */
function moveAndOrganizeFile(file, rootDestFolder, data) {
  var claimFolder;
  var claimFolders = rootDestFolder.getFoldersByName(data.claimFolderName);
  if (claimFolders.hasNext()) {
    claimFolder = claimFolders.next();
  } else {
    claimFolder = rootDestFolder.createFolder(data.claimFolderName);
  }
  
  var newName = data.category + "_" + file.getName();
  file.moveTo(claimFolder);
  file.setName(newName);
  
  Logger.log("  -> Moved to " + claimFolder.getName() + " as " + newName);
}

/**
 * Updates (or creates) the consolidated Excel/Sheet report.
 */
function updateConsolidatedSheet(rootDestFolder, data) {
  var claimFolder = rootDestFolder.getFoldersByName(data.claimFolderName).next();
  var sheetFile;
  var files = claimFolder.getFilesByName("Consolidated_Report");
  
  if (files.hasNext()) {
    sheetFile = files.next();
  } else {
    // Create new spreadsheet using SpreadsheetApp
    var ss = SpreadsheetApp.create("Consolidated_Report");
    var sheet = ss.getSheets()[0];
    sheet.appendRow(["Patient Name", "UHID", "Clinic/Hospital", "Bill Number", "Category", "Amount", "Doc Date", "Date Added"]);
    
    // Move the file to the correct folder using DriveApp
    var file = DriveApp.getFileById(ss.getId());
    file.moveTo(claimFolder);
    
    sheetFile = file;
  }
  
  var ss = SpreadsheetApp.openById(sheetFile.getId());
  var sheet = ss.getSheets()[0];
  sheet.appendRow([
    data.patientName || "",
    data.uhid || "",
    data.clinicName || "",
    data.billNumber || "",
    data.category || "",
    data.amount || "",
    data.documentDate || "",
    new Date()
  ]);
}

// --- Helpers ---

function parseDate(dateStr) {
  if (!dateStr) return new Date();
  var parts = dateStr.split("-");
  if (parts.length === 3) {
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date();
}

function formatDate(date) {
  var d = new Date(date),
      month = '' + (d.getMonth() + 1),
      day = '' + d.getDate(),
      year = d.getFullYear();

  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;

  return [year, month, day].join('-');
}

