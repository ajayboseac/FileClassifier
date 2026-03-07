/**
 * Main function to process files.
 * Set this up with a Time-driven trigger (e.g., every 15 mins).
 */
function processFiles() {
  var sourceFolder = DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID);
  var destFolder = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID);
  
  // 0. Load Duplicate Registry (if enabled)
  var registry = null;
  if (CONFIG.ENABLE_DUPLICATE_DETECTION) {
    registry = getOrCreateDuplicateRegistry(destFolder);
    Logger.log("Duplicate detection ON — registry has " + registry.data.length + " entries.");
  }
  
  // 1. Get Existing Claims Metadata
  var existingClaims = getExistingClaimsMetadata(destFolder);
  
  // 2. Classify ALL new files
  var fileDataList = [];
  var files = sourceFolder.getFiles();
  
  while (files.hasNext()) {
    var file = files.next();
    Logger.log("Processing file: " + file.getName());
    
    // ── Duplicate Check Gate (runs BEFORE expensive LLM call) ──
    if (CONFIG.ENABLE_DUPLICATE_DETECTION && registry) {
      var dupCheck = isDuplicate(file, registry.data);
      if (dupCheck.isDuplicate) {
        Logger.log("  -> DUPLICATE DETECTED: " + dupCheck.reason);
        handleDuplicate(file, destFolder, dupCheck);
        continue; // Skip this file entirely
      }
    }
    
    try {
      var fileInput = prepareFileForLLM(file);
      if (!fileInput) {
        Logger.log("  -> Could not prepare file for analysis. Skipping.");
        continue;
      }
      
      var result = callLLM(fileInput);
      if (result && result.metadata) {
        var metadata = result.metadata;
        metadata.fileId = file.getId();
        metadata.fileName = file.getName();
        metadata.rawLLMResponse = result.rawResponse;
        // Ensure date is valid, else use today
        metadata.dateObj = parseDate(metadata.documentDate);
        
        // Store MD5 hash (may already be computed during duplicate check)
        if (CONFIG.ENABLE_DUPLICATE_DETECTION) {
          metadata.md5Hash = getFileMD5(file);
        }
        
        fileDataList.push(metadata);
      }
    } catch (e) {
      Logger.log("  -> Error processing file " + file.getName() + ": " + e.toString());
    }
  }
  
  // 3. Group and Assign Claims
  // Sort by date ascending to process in chronological order
  fileDataList.sort(function(a, b) { return a.dateObj - b.dateObj; });
  
  for (var i = 0; i < fileDataList.length; i++) {
    var data = fileDataList[i];
    var assignedClaim = findMatchingClaim(data, existingClaims);
    
    if (assignedClaim) {
      data.claimFolderName = assignedClaim.folderName;
    } else {
      // Create New Claim
      var newClaimName = generateClaimName(data);
      data.claimFolderName = newClaimName;
      
      // Add to existing claims so subsequent files in this batch can match it
      existingClaims.push({
        folderName: newClaimName,
        patientName: normalizeName(data.patientName || "Unknown"),
        startDate: data.dateObj
      });
    }
    
    // 4. Move File, Update Sheet & Log Classification
    var file = DriveApp.getFileById(data.fileId);
    moveAndOrganizeFile(file, destFolder, data);
    // Only update the basic Consolidated_Report if prescription linkage is disabled
    // (Pass 2 will generate the enhanced 3-tab report when linkage is enabled)
    if (!CONFIG.ENABLE_PRESCRIPTION_LINKAGE) {
      updateConsolidatedSheet(destFolder, data);
    }
    logClassification(destFolder, data);
    
    // 5. Register in Duplicate Registry (prevents re-processing on next run)
    if (CONFIG.ENABLE_DUPLICATE_DETECTION && registry) {
      registerProcessedFile(registry.sheet, data);
      // Also add to in-memory data so duplicates within the SAME batch are caught
      registry.data.push({
        fileId: data.fileId,
        md5Hash: data.md5Hash || "",
        originalName: data.fileName,
        category: data.category,
        patientName: data.patientName || "",
        documentDate: data.documentDate || "",
        claimFolder: data.claimFolderName || "",
        processedAt: new Date(),
        billNumber: data.billNumber || ""
      });
    }
  }
  
  // ══════════════════════════════════════════════════════════════════════════
  // PASS 2: Prescription Linkage & Claim Validation
  // ══════════════════════════════════════════════════════════════════════════
  if (CONFIG.ENABLE_PRESCRIPTION_LINKAGE && fileDataList.length > 0) {
    Logger.log("\n=== STARTING PASS 2: Prescription Linkage ===");
    
    // Collect unique claim folders touched in this batch
    var touchedClaims = {};
    for (var i = 0; i < fileDataList.length; i++) {
      var claimName = fileDataList[i].claimFolderName;
      if (!touchedClaims[claimName]) {
        touchedClaims[claimName] = [];
      }
      touchedClaims[claimName].push(fileDataList[i]);
    }
    
    // Run linkage for each claim folder
    var claimNames = Object.keys(touchedClaims);
    for (var c = 0; c < claimNames.length; c++) {
      var claimName = claimNames[c];
      var claimFiles = touchedClaims[claimName];
      
      try {
        var linkageSummary = runPrescriptionLinkage(destFolder, claimName, claimFiles);
        Logger.log("  Claim '" + claimName + "': " +
                   "₹" + linkageSummary.totalReimbursable + " reimbursable, " +
                   "₹" + linkageSummary.totalNonReimbursable + " not reimbursable, " +
                   (linkageSummary.isComplete ? "✅ Complete" : "⚠️ Incomplete"));
      } catch (e) {
        Logger.log("  ERROR in prescription linkage for '" + claimName + "': " + e.toString());
        // Fall back to basic report
        for (var f = 0; f < claimFiles.length; f++) {
          updateConsolidatedSheet(destFolder, claimFiles[f]);
        }
      }
    }
    
    Logger.log("=== PASS 2 COMPLETE ===\n");
  }
}


// =============================================================================
// FILE PREPARATION (Vision-first approach)
// =============================================================================

/**
 * Prepares a file for LLM analysis.
 * For images and PDFs: returns base64 data for Gemini Vision (preferred).
 * For text/docs: returns extracted text as fallback.
 */
function prepareFileForLLM(file) {
  var mimeType = file.getMimeType();
  
  // MIME types that Gemini Vision can process directly
  var visionMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/bmp",
    "image/webp",
    "image/tiff"
  ];
  
  // Prefer Vision for images and PDFs (much better accuracy)
  if (visionMimeTypes.indexOf(mimeType) !== -1) {
    try {
      var blob = file.getBlob();
      var bytes = blob.getBytes();
      
      // Gemini inline data limit is ~20MB; be conservative
      if (bytes.length > 15 * 1024 * 1024) {
        Logger.log("  -> File too large for Vision API (" + Math.round(bytes.length / 1024 / 1024) + "MB). Falling back to OCR.");
        return prepareViaOCR(file);
      }
      
      var base64 = Utilities.base64Encode(bytes);
      Logger.log("  -> Prepared for Gemini Vision (" + Math.round(bytes.length / 1024) + "KB, " + mimeType + ")");
      
      return {
        type: "vision",
        base64: base64,
        mimeType: mimeType,
        fileName: file.getName()
      };
    } catch (e) {
      Logger.log("  -> Vision prep failed: " + e.toString() + ". Falling back to OCR.");
      return prepareViaOCR(file);
    }
  }
  
  // Google Docs — extract text directly
  if (mimeType === MimeType.GOOGLE_DOCS) {
    var text = DocumentApp.openById(file.getId()).getBody().getText();
    if (text && text.length >= 10) {
      return { type: "text", text: text, fileName: file.getName() };
    }
    Logger.log("  -> Google Doc had insufficient text.");
    return null;
  }
  
  // Plain text files
  if (mimeType === MimeType.PLAIN_TEXT) {
    var text = file.getBlob().getDataAsString();
    if (text && text.length >= 10) {
      return { type: "text", text: text, fileName: file.getName() };
    }
    Logger.log("  -> Plain text file had insufficient content.");
    return null;
  }
  
  // Anything else — try OCR as last resort
  return prepareViaOCR(file);
}

/**
 * Fallback: Uses Google Drive's OCR to extract text from a file.
 */
function prepareViaOCR(file) {
  var resource = {
    name: "Temp OCR Doc",
    mimeType: MimeType.GOOGLE_DOCS
  };
  
  var options = { ocrLanguage: "en" };
  
  try {
    var tempFile = Drive.Files.copy(resource, file.getId(), options);
    var doc = DocumentApp.openById(tempFile.id);
    var text = doc.getBody().getText();
    Drive.Files.remove(tempFile.id);
    
    if (text && text.length >= 10) {
      Logger.log("  -> OCR extracted " + text.length + " characters.");
      return { type: "text", text: text, fileName: file.getName() };
    }
    Logger.log("  -> OCR produced insufficient text.");
  } catch (e) {
    Logger.log("  -> OCR Failed: " + e.toString());
  }
  
  return null;
}

// =============================================================================
// LLM CLASSIFICATION
// =============================================================================

/** All valid document categories. */
var VALID_CATEGORIES = [
  "Prescription",
  "Consultation Bill",
  "Medicine Bill",
  "Pharmacy Receipt",
  "Diagnostics Bill",
  "Lab Report",
  "Radiology Report",
  "Discharge Summary",
  "Hospital Bill",
  "Insurance Form",
  "Doctor Notes",
  "Other"
];

/**
 * Builds the detailed classification prompt with category definitions,
 * disambiguation rules, and output format specification.
 * Includes structured item extraction for prescription linkage.
 */
function buildClassificationPrompt() {
  return 'You are an expert medical document classifier for Indian health insurance claims.\n\n' +
    'TASK: Analyze the provided document and extract structured metadata.\n\n' +
    'CATEGORIES — choose the single best match:\n' +
    '1. "Prescription" — A doctor\'s prescription listing medicines to be taken. May be handwritten or printed. Contains drug names, dosages, frequency. Does NOT include price/bill amounts for the medicines.\n' +
    '2. "Consultation Bill" — A bill/invoice/receipt for a doctor\'s consultation or OPD visit. Shows consultation fees charged.\n' +
    '3. "Medicine Bill" — A pharmacy bill/invoice for medicines purchased. Lists medicine names with individual prices.\n' +
    '4. "Pharmacy Receipt" — A brief payment receipt from a pharmacy confirming total payment for medicines, without itemized list.\n' +
    '5. "Diagnostics Bill" — A bill/invoice for diagnostic tests (blood tests, urine tests, etc.). Shows test names and charges only, NOT the test results.\n' +
    '6. "Lab Report" — A laboratory test report with actual test RESULTS and VALUES (e.g., blood count, sugar levels, thyroid panel, lipid panel, liver function test, kidney function test). Contains observed values and reference ranges. Key indicator: presence of numerical results with normal/reference ranges.\n' +
    '7. "Radiology Report" — An imaging/radiology report: X-ray, MRI, CT scan, ultrasound, sonography, mammography, DEXA scan, PET scan, echocardiogram, or any other imaging study. Contains findings and/or radiologist impressions. May include images. Key indicator: mentions of "findings", "impression", imaging modality names.\n' +
    '8. "Discharge Summary" — A hospital discharge summary issued when a patient leaves the hospital. Contains admission date, discharge date, diagnosis, treatment given, and instructions.\n' +
    '9. "Hospital Bill" — A consolidated hospital bill for inpatient stay, surgery, or procedures. Typically large bills with multiple line items (room rent, surgery charges, consumables, etc.).\n' +
    '10. "Insurance Form" — An insurance claim form, pre-authorization form, cashless letter, or TPA document. Contains policy numbers, claim IDs, or insurance company references.\n' +
    '11. "Doctor Notes" — Clinical notes, follow-up notes, or referral letters from a doctor that are NOT prescriptions (no medicine list) and NOT bills.\n' +
    '12. "Other" — ONLY if the document does not fit any category above.\n\n' +
    'DISAMBIGUATION RULES (apply these strictly):\n' +
    '- Document has test RESULTS with numerical values and reference ranges → "Lab Report" (NOT "Diagnostics Bill")\n' +
    '- Document charges for tests but shows NO results → "Diagnostics Bill"\n' +
    '- Document has IMAGING findings (X-ray, MRI, CT, ultrasound, sonography, echo) → "Radiology Report" (NOT "Lab Report")\n' +
    '- Document lists medicines with dosage instructions for the patient to take → "Prescription" (NOT "Doctor Notes")\n' +
    '- Document is both a bill AND contains lab results → classify by PRIMARY purpose. If it mainly shows results, it is a "Lab Report".\n' +
    '- Handwritten notes listing medicines and dosages → "Prescription"\n' +
    '- A pharmacy receipt showing only total amount paid → "Pharmacy Receipt"; one with itemized medicines and prices → "Medicine Bill"\n' +
    '- ECG/EKG reports → "Radiology Report"\n' +
    '- Pathology/histopathology reports → "Lab Report"\n\n' +
    'EXTRACT THESE FIELDS:\n' +
    '- category: One of the exact category strings listed above.\n' +
    '- documentDate: Date on the document in YYYY-MM-DD format. Look for "Date:", "Report Date:", "Bill Date:", "Consultation Date:", etc. null if not found.\n' +
    '- patientName: Full name of the patient without titles (remove Dr/Mr/Mrs/Ms/Smt/Shri/Master). null if not found.\n' +
    '- clinicName: Hospital, clinic, lab, or pharmacy name. null if not found.\n' +
    '- billNumber: Invoice/bill/receipt/report number. null if not found.\n' +
    '- amount: Total amount with currency (e.g., "1500 INR"). null if not a bill or no amount shown.\n' +
    '- doctorName: Name of the doctor mentioned. null if not found.\n' +
    '- notes: Brief additional context (e.g., "Handwritten prescription", "Partially illegible", "Ultrasound of abdomen", "Complete blood count"). null if nothing notable.\n\n' +
    'STRUCTURED LINE ITEM EXTRACTION (for insurance reimbursement linkage):\n\n' +
    'If category is "Prescription":\n' +
    '  Extract "prescribedItems" — an array of objects for each medicine or test prescribed:\n' +
    '  - name: Medicine or test name exactly as written on the document\n' +
    '  - type: "medicine" if it is a drug/tablet/capsule/syrup/injection, or "test" if it is a lab test, blood test, imaging study, or diagnostic test\n' +
    '  - dosage: Dosage instructions as written (e.g., "1-0-1", "500mg BD"). null if not a medicine or not specified\n' +
    '  - days: Number of days prescribed. null if not specified or not a medicine\n' +
    '  If no items can be extracted, set prescribedItems to an empty array [].\n\n' +
    'If category is "Medicine Bill" or "Pharmacy Receipt":\n' +
    '  Extract "billedItems" — an array of objects for each medicine on the bill:\n' +
    '  - name: Medicine name exactly as written\n' +
    '  - quantity: Number of units/strips purchased. null if not shown\n' +
    '  - price: Price for this item as a string with currency (e.g., "150 INR"). null if not shown\n' +
    '  If no items can be extracted, set billedItems to an empty array [].\n\n' +
    'If category is "Diagnostics Bill":\n' +
    '  Extract "billedItems" — an array of objects for each test billed:\n' +
    '  - name: Test name exactly as written\n' +
    '  - quantity: null (not applicable for tests)\n' +
    '  - price: Price for this test as a string with currency (e.g., "800 INR"). null if not shown\n' +
    '  If no items can be extracted, set billedItems to an empty array [].\n\n' +
    'If category is "Lab Report" or "Radiology Report":\n' +
    '  Extract "reportedTests" — an array of objects for each test reported:\n' +
    '  - name: Test name exactly as written (e.g., "Complete Blood Count", "Ultrasound Abdomen")\n' +
    '  If no test names can be identified, set reportedTests to an empty array [].\n\n' +
    'For all other categories (Consultation Bill, Discharge Summary, Hospital Bill, Insurance Form, Doctor Notes, Other):\n' +
    '  Do NOT include prescribedItems, billedItems, or reportedTests fields.\n\n' +
    'Respond with ONLY valid JSON. No markdown, no explanation, no code fences.\n' +
    'Example for Prescription: {"category":"Prescription","documentDate":"2025-03-15","patientName":"Ajay Bose","clinicName":"Apollo Clinic","billNumber":null,"amount":null,"doctorName":"Dr. Sharma","notes":"Handwritten prescription","prescribedItems":[{"name":"Amoxicillin 500mg","type":"medicine","dosage":"1-0-1","days":5},{"name":"Complete Blood Count","type":"test","dosage":null,"days":null}]}\n' +
    'Example for Medicine Bill: {"category":"Medicine Bill","documentDate":"2025-03-15","patientName":"Ajay Bose","clinicName":"MedPlus","billNumber":"INV-1234","amount":"180 INR","doctorName":null,"notes":null,"billedItems":[{"name":"Amoxicillin 500mg","quantity":10,"price":"150 INR"},{"name":"Paracetamol 650mg","quantity":5,"price":"30 INR"}]}\n' +
    'Example for Lab Report: {"category":"Lab Report","documentDate":"2025-03-16","patientName":"Ajay Bose","clinicName":"SRL Diagnostics","billNumber":"RPT-5678","amount":null,"doctorName":"Dr. Sharma","notes":"Complete blood count results","reportedTests":[{"name":"Complete Blood Count"},{"name":"ESR"}]}';
}


/**
 * Calls Gemini API to classify the document.
 * Supports both Vision (image/PDF) and text-only input.
 */
function callLLM(fileInput) {
  var prompt = buildClassificationPrompt();
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
            CONFIG.MODEL_NAME + ":generateContent?key=" + CONFIG.API_KEY;
  
  // Build the request parts
  var parts = [];
  parts.push({ text: prompt });
  
  if (fileInput.type === "vision") {
    // Send file directly to Gemini Vision — much better for scans & handwriting
    parts.push({
      inline_data: {
        mime_type: fileInput.mimeType,
        data: fileInput.base64
      }
    });
    Logger.log("  -> Sending to Gemini Vision: " + fileInput.fileName);
  } else {
    // Text input — use smart truncation (first half + last half)
    var text = fileInput.text;
    var MAX_CHARS = 10000;
    var truncatedText;
    
    if (text.length > MAX_CHARS) {
      var halfLimit = Math.floor(MAX_CHARS / 2);
      truncatedText = text.substring(0, halfLimit) +
                      "\n\n[...MIDDLE SECTION TRUNCATED...]\n\n" +
                      text.substring(text.length - halfLimit);
      Logger.log("  -> Text truncated: " + text.length + " -> ~" + MAX_CHARS + " chars (first + last halves)");
    } else {
      truncatedText = text;
    }
    
    parts.push({ text: "\n\nDocument Text:\n" + truncatedText });
    Logger.log("  -> Sending text to Gemini: " + fileInput.fileName);
  }
  
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.1
    }
  };
  
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseBody = response.getContentText();
  
  if (responseCode !== 200) {
    Logger.log("  -> API Error (HTTP " + responseCode + "): " + responseBody.substring(0, 500));
    return null;
  }
  
  var json = JSON.parse(responseBody);
  
  if (json.candidates && json.candidates[0] && json.candidates[0].content) {
    var responseText = json.candidates[0].content.parts[0].text;
    var rawResponse = responseText;
    
    // Clean up any accidental markdown fencing
    responseText = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    
    var metadata = parseAndValidateLLMResponse(responseText);
    if (metadata) {
      return { metadata: metadata, rawResponse: rawResponse };
    }
  }
  
  // Check for safety blocks or other issues
  if (json.candidates && json.candidates[0] && json.candidates[0].finishReason) {
    Logger.log("  -> LLM finish reason: " + json.candidates[0].finishReason);
  }
  
  Logger.log("  -> LLM returned no usable response: " + JSON.stringify(json).substring(0, 500));
  return null;
}

/**
 * Parses and validates the LLM JSON response.
 * Returns validated metadata object, or null on failure.
 */
function parseAndValidateLLMResponse(responseText) {
  try {
    var data = JSON.parse(responseText);
    
    // Validate category is in the allowed list
    if (!data.category || VALID_CATEGORIES.indexOf(data.category) === -1) {
      var originalCategory = data.category || "(empty)";
      Logger.log("  -> WARNING: Invalid category '" + originalCategory + "'. Defaulting to 'Other'.");
      data.notes = (data.notes || "") + " [Original LLM category: " + originalCategory + "]";
      data.category = "Other";
    }
    
    // Normalize patient name — remove titles
    if (data.patientName) {
      data.patientName = data.patientName
        .replace(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Smt\.?|Shri\.?|Master\.?|Baby\.?|Mast\.?)\s*/gi, "")
        .trim();
    }
    
    // Validate date format (YYYY-MM-DD)
    if (data.documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.documentDate)) {
      Logger.log("  -> WARNING: Invalid date format '" + data.documentDate + "'. Setting to null.");
      data.documentDate = null;
    }
    
    // Validate structured line item arrays (for prescription linkage)
    // Ensure these are always arrays, defaulting to [] if missing or wrong type
    if (data.category === "Prescription") {
      if (!Array.isArray(data.prescribedItems)) {
        data.prescribedItems = [];
      }
      Logger.log("  -> Extracted " + data.prescribedItems.length + " prescribed item(s)");
    }
    
    if (data.category === "Medicine Bill" || data.category === "Pharmacy Receipt" || data.category === "Diagnostics Bill") {
      if (!Array.isArray(data.billedItems)) {
        data.billedItems = [];
      }
      Logger.log("  -> Extracted " + data.billedItems.length + " billed item(s)");
    }
    
    if (data.category === "Lab Report" || data.category === "Radiology Report") {
      if (!Array.isArray(data.reportedTests)) {
        data.reportedTests = [];
      }
      Logger.log("  -> Extracted " + data.reportedTests.length + " reported test(s)");
    }
    
    Logger.log("  -> Classified as: " + data.category +
               " | Patient: " + (data.patientName || "Unknown") +
               " | Date: " + (data.documentDate || "Unknown") +
               " | Clinic: " + (data.clinicName || "Unknown"));
    
    return data;
    
  } catch (e) {
    Logger.log("  -> ERROR: Failed to parse LLM JSON: " + e.toString());
    Logger.log("  -> Raw response: " + responseText.substring(0, 500));
    return null;
  }
}


// =============================================================================
// CLAIM MATCHING & ORGANIZATION
// =============================================================================

/**
 * Parses existing claim folders to build metadata list.
 * Folder Name Format: PatientName_YYYY-MM-DD
 */
function getExistingClaimsMetadata(rootFolder) {
  var claims = [];
  var folders = rootFolder.getFolders();
  
  while (folders.hasNext()) {
    var folder = folders.next();
    var name = folder.getName();
    var parts = name.split("_");
    
    // Expected format: Name_Date (or Name_Part2_Date)
    if (parts.length >= 2) {
      var dateStr = parts[parts.length - 1]; // Last part is date
      var patientName = parts.slice(0, parts.length - 1).join(" ");
      
      var dateObj = parseDate(dateStr);
      if (dateObj) {
        claims.push({
          folderName: name,
          patientName: normalizeName(patientName),
          startDate: dateObj
        });
      }
    }
  }
  return claims;
}

/**
 * Finds a matching existing claim for a file.
 * Uses fuzzy name matching (token overlap + Levenshtein) and a 14-day date window.
 */
function findMatchingClaim(fileData, existingClaims) {
  if (!fileData.patientName) return null;
  
  var fileNameNorm = normalizeName(fileData.patientName);
  var TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  
  var bestMatch = null;
  var bestScore = 0;
  
  for (var i = 0; i < existingClaims.length; i++) {
    var claim = existingClaims[i];
    var nameScore = calculateNameSimilarity(fileNameNorm, claim.patientName);
    
    // Require at least 70% name similarity
    if (nameScore >= 0.7) {
      var diff = Math.abs(fileData.dateObj - claim.startDate);
      if (diff <= TWO_WEEKS_MS && nameScore > bestScore) {
        bestMatch = claim;
        bestScore = nameScore;
      }
    }
  }
  
  if (bestMatch) {
    Logger.log("  -> Matched to claim: " + bestMatch.folderName +
               " (name similarity: " + Math.round(bestScore * 100) + "%)");
  }
  
  return bestMatch;
}

/**
 * Generates a new claim folder name.
 * Format: PatientName_YYYY-MM-DD
 */
function generateClaimName(data) {
  var safeName = (data.patientName || "Unknown").replace(/[^a-zA-Z0-9]/g, "");
  var dateStr = data.documentDate || formatDate(new Date());
  
  return safeName + "_" + dateStr;
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

// =============================================================================
// REPORTING & LOGGING
// =============================================================================

/**
 * Updates (or creates) the consolidated Excel/Sheet report in the claim folder.
 */
function updateConsolidatedSheet(rootDestFolder, data) {
  var claimFolder = rootDestFolder.getFoldersByName(data.claimFolderName).next();
  var sheetFile;
  var files = claimFolder.getFilesByName("Consolidated_Report");
  
  if (files.hasNext()) {
    sheetFile = files.next();
  } else {
    // Create new spreadsheet
    var ss = SpreadsheetApp.create("Consolidated_Report");
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "Patient Name", "Clinic/Hospital", "Doctor", "Bill Number",
      "Category", "Amount", "Doc Date", "Date Added", "Notes"
    ]);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold");
    
    // Move to the claim folder
    var file = DriveApp.getFileById(ss.getId());
    file.moveTo(claimFolder);
    sheetFile = file;
  }
  
  var ss = SpreadsheetApp.openById(sheetFile.getId());
  var sheet = ss.getSheets()[0];
  sheet.appendRow([
    data.patientName || "",
    data.clinicName || "",
    data.doctorName || "",
    data.billNumber || "",
    data.category || "",
    data.amount || "",
    data.documentDate || "",
    new Date(),
    data.notes || ""
  ]);
}

/**
 * Logs every classification decision to a central Classification_Log sheet.
 * This enables auditing and debugging misclassifications.
 */
function logClassification(rootDestFolder, data) {
  var logSheetName = "Classification_Log";
  var logFile;
  var files = rootDestFolder.getFilesByName(logSheetName);
  
  if (files.hasNext()) {
    logFile = files.next();
  } else {
    // Create the log sheet
    var ss = SpreadsheetApp.create(logSheetName);
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "Timestamp", "Original File Name", "Assigned Category",
      "Patient Name", "Document Date", "Clinic/Hospital", "Doctor",
      "Amount", "Bill Number", "Claim Folder", "Notes", "Raw LLM Response"
    ]);
    sheet.getRange(1, 1, 1, 12).setFontWeight("bold");
    sheet.setFrozenRows(1);
    
    var file = DriveApp.getFileById(ss.getId());
    file.moveTo(rootDestFolder);
    logFile = file;
  }
  
  var ss = SpreadsheetApp.openById(logFile.getId());
  var sheet = ss.getSheets()[0];
  sheet.appendRow([
    new Date(),
    data.fileName || "",
    data.category || "",
    data.patientName || "",
    data.documentDate || "",
    data.clinicName || "",
    data.doctorName || "",
    data.amount || "",
    data.billNumber || "",
    data.claimFolderName || "",
    data.notes || "",
    data.rawLLMResponse || ""
  ]);
}

// =============================================================================
// NAME MATCHING UTILITIES
// =============================================================================

/**
 * Normalizes a name for comparison.
 * Removes titles, special characters, extra spaces, and lowercases.
 */
function normalizeName(name) {
  if (!name) return "";
  return name
    .replace(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Smt\.?|Shri\.?|Master\.?|Baby\.?|Mast\.?)\s*/gi, "")
    .replace(/[^a-zA-Z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Calculates similarity between two normalized names using token overlap.
 * Returns a score between 0.0 and 1.0.
 */
function calculateNameSimilarity(name1, name2) {
  if (name1 === name2) return 1.0;
  if (!name1 || !name2) return 0.0;
  
  var tokens1 = name1.split(" ").filter(function(t) { return t.length > 0; });
  var tokens2 = name2.split(" ").filter(function(t) { return t.length > 0; });
  
  if (tokens1.length === 0 || tokens2.length === 0) return 0.0;
  
  // Count matching tokens (exact, substring, or fuzzy)
  var matchCount = 0;
  var totalTokens = Math.max(tokens1.length, tokens2.length);
  
  for (var i = 0; i < tokens1.length; i++) {
    for (var j = 0; j < tokens2.length; j++) {
      // Exact match
      if (tokens1[i] === tokens2[j]) {
        matchCount += 1.0;
        break;
      }
      // Substring match (handles abbreviations, e.g., "raj" in "rajesh")
      if (tokens1[i].length > 2 && tokens2[j].length > 2) {
        if (tokens1[i].indexOf(tokens2[j]) !== -1 || tokens2[j].indexOf(tokens1[i]) !== -1) {
          matchCount += 0.7;
          break;
        }
        // Levenshtein distance for typos/OCR errors
        var maxLen = Math.max(tokens1[i].length, tokens2[j].length);
        var dist = levenshteinDistance(tokens1[i], tokens2[j]);
        if (dist <= Math.floor(maxLen * 0.3)) { // Allow up to ~30% character difference
          matchCount += 0.8;
          break;
        }
      }
    }
  }
  
  return matchCount / totalTokens;
}

/**
 * Computes the Levenshtein (edit) distance between two strings.
 */
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  var matrix = [];
  
  for (var i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (var j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (var i = 1; i <= b.length; i++) {
    for (var j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

// =============================================================================
// DATE HELPERS
// =============================================================================

function parseDate(dateStr) {
  if (!dateStr) return new Date();
  var parts = dateStr.split("-");
  if (parts.length === 3) {
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    // Validate the parsed date is reasonable
    if (!isNaN(d.getTime())) {
      return d;
    }
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
