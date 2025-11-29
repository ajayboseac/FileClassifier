/**
 * Main function to process files.
 * Set this up with a Time-driven trigger (e.g., every 15 mins).
 */
function processFiles() {
  var sourceFolder = DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID);
  var destFolder = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID);
  
  // Get existing claim folders to help LLM match (Limit to last 5 recent)
  var existingClaims = getRecentClaimNames(destFolder, 5);
  
  var files = sourceFolder.getFiles();
  
  while (files.hasNext()) {
    var file = files.next();
    Logger.log("Processing file: " + file.getName());
    
    try {
      // 1. Extract Text
      var text = extractText(file);
      if (!text || text.length < 10) {
        Logger.log("  -> Not enough text found. Skipping.");
        continue;
      }
      
      // 2. Classify with LLM
      var classification = callLLM(text, existingClaims);
      Logger.log("  -> Classified: " + JSON.stringify(classification));
      
      if (classification && classification.category && classification.claimName) {
        // 3. Move File
        moveAndOrganizeFile(file, destFolder, classification);
        
        // 4. Update Sheet
        updateConsolidatedSheet(destFolder, classification);
      } else {
        Logger.log("  -> Could not classify. Keeping in source.");
      }
      
    } catch (e) {
      Logger.log("  -> Error: " + e.toString());
    }
  }
}

/**
 * Extracts text from a file (PDF or Image) using Google Drive's OCR.
 */
function extractText(file) {
  var mimeType = file.getMimeType();
  
  // If it's already a Google Doc, just read it (unlikely for raw files)
  if (mimeType === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(file.getId()).getBody().getText();
  }
  
  // For PDFs/Images, we use a trick: Copy it to a Google Doc with OCR enabled, read text, then delete temp doc.
  var resource = {
    title: "Temp OCR Doc",
    mimeType: MimeType.GOOGLE_DOCS
  };
  
  // Enable OCR
  var options = {
    ocr: true,
    ocrLanguage: "en"
  };
  
  try {
    var tempFile = Drive.Files.copy(resource, file.getId(), options);
    var doc = DocumentApp.openById(tempFile.id);
    var text = doc.getBody().getText();
    
    // Cleanup
    Drive.Files.remove(tempFile.id);
    return text;
  } catch (e) {
    Logger.log("  -> OCR Failed: " + e.toString());
    // Fallback: If it's a text file
    if (mimeType === MimeType.PLAIN_TEXT) {
      return file.getBlob().getDataAsString();
    }
    return null;
  }
}

/**
 * Calls Gemini API to classify the text.
 */
function callLLM(text, existingClaims) {
  var prompt = `
  You are a helpful assistant that organizes health insurance documents.
  
  Existing Claim Folders: ${JSON.stringify(existingClaims)}
  
  Analyze the following document text and extract:
  1. Category: One of ["Prescription", "Consultation Bill", "Medicine Bill", "Diagnostics Bill", "Other"].
  2. Claim Name: A folder name for the claim.
     - Format: "{PatientName}_{Month_Year}_{Disease}" (e.g., "Taps_Jan_2025_Fever").
     - IMPORTANT: Check the "Existing Claim Folders" list above. If the document belongs to one of them, USE THAT EXACT NAME.
     - If it's a new event, generate a new name following the format.
  3. Patient Name
  4. Disease (if available, else "Unknown")
  5. Clinic/Hospital Name
  6. Bill Number (if available)
  7. Amount (with currency)
  
  Return ONLY valid JSON.
  Example: { 
    "category": "Prescription", 
    "claimName": "Taps_Jan_2025_Fever",
    "patientName": "Taps",
    "disease": "Fever",
    "clinicName": "Apollo Hospital",
    "billNumber": "INV-123",
    "amount": "500 INR"
  }
  
  Document Text:
  ${text.substring(0, 2000)} 
  `;
  // Truncate to 2000 chars to save tokens/money, usually enough for header info.

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
    // Clean up markdown code blocks if present
    responseText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(responseText);
  }
  
  Logger.log("LLM Response Error: " + JSON.stringify(json));
  return null;
}

/**
 * Helper to get list of recent claim folders (sorted by last updated).
 */
function getRecentClaimNames(folder, limit) {
  var folders = [];
  var iterator = folder.getFolders();
  while (iterator.hasNext()) {
    var f = iterator.next();
    folders.push({
      name: f.getName(),
      updated: f.getLastUpdated().getTime()
    });
  }
  
  // Sort by date descending (newest first)
  folders.sort(function(a, b) { return b.updated - a.updated; });
  
  // Take top N
  return folders.slice(0, limit).map(function(f) { return f.name; });
}

/**
 * Moves the file to the correct destination folder.
 */
function moveAndOrganizeFile(file, rootDestFolder, classification) {
  // 1. Get or Create Claim Folder (e.g., "Taps_Fever_2025")
  var claimFolder;
  var claimFolders = rootDestFolder.getFoldersByName(classification.claimName);
  if (claimFolders.hasNext()) {
    claimFolder = claimFolders.next();
  } else {
    claimFolder = rootDestFolder.createFolder(classification.claimName);
  }
  
  // 2. Move File
  var newName = classification.category + "_" + file.getName();
  file.moveTo(claimFolder);
  file.setName(newName);
  
  Logger.log("  -> Moved to " + claimFolder.getName() + " as " + newName);
}

/**
 * Updates (or creates) the consolidated Excel/Sheet report.
 */
function updateConsolidatedSheet(rootDestFolder, data) {
  var claimFolder = rootDestFolder.getFoldersByName(data.claimName).next();
  var sheetFile;
  var files = claimFolder.getFilesByName("Consolidated_Report");
  
  if (files.hasNext()) {
    sheetFile = files.next();
  } else {
    // Create new Sheet
    var resource = {
      title: "Consolidated_Report",
      mimeType: MimeType.GOOGLE_SHEETS,
      parents: [{id: claimFolder.getId()}]
    };
    sheetFile = Drive.Files.insert(resource);
    
    // Add Header
    var ss = SpreadsheetApp.openById(sheetFile.id);
    var sheet = ss.getSheets()[0];
    sheet.appendRow(["Patient Name", "Disease", "Clinic/Hospital", "Bill Number", "Category", "Amount", "Date Added"]);
  }
  
  // Append Data
  var ss = SpreadsheetApp.openById(sheetFile.id);
  var sheet = ss.getSheets()[0];
  sheet.appendRow([
    data.patientName || "",
    data.disease || "",
    data.clinicName || "",
    data.billNumber || "",
    data.category || "",
    data.amount || "",
    new Date()
  ]);
  
  Logger.log("  -> Updated Consolidated Report");
}
