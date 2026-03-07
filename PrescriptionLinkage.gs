// =============================================================================
// PRESCRIPTION-CENTRIC REIMBURSEMENT LINKAGE
// Links bills and reports back to prescriptions to determine what is
// reimbursable by insurance.
// =============================================================================

/**
 * Normalizes a medicine or test name for fuzzy matching.
 * Strips dosage forms, strengths, extra whitespace, and lowercases.
 *
 * Examples:
 *   "Amoxicillin 500mg Tab" → "amoxicillin"
 *   "Tab. Paracetamol 650 mg" → "paracetamol"
 *   "Complete Blood Count (CBC)" → "complete blood count cbc"
 */
function normalizeDrugName(name) {
  if (!name) return "";
  return name
    // Remove dosage forms
    .replace(/\b(tab\.?|tablet|cap\.?|capsule|inj\.?|injection|syrup|syr\.?|cream|ointment|gel|drops|susp\.?|suspension|lotion|powder|sachet|inhaler)\b/gi, "")
    // Remove strengths like "500mg", "250 mg", "10ml", "0.5%"
    .replace(/\d+(\.\d+)?\s*(mg|mcg|gm|g|ml|l|iu|%|units?)\b/gi, "")
    // Remove frequency patterns like "1-0-1", "BD", "TDS", "OD"
    .replace(/\b\d+-\d+-\d+\b/g, "")
    .replace(/\b(od|bd|tds|qds|hs|sos|prn|stat)\b/gi, "")
    // Remove parentheses but keep content inside
    .replace(/[()]/g, " ")
    // Remove special characters except spaces
    .replace(/[^a-zA-Z\s]/g, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Parses an amount string like "1500 INR" or "₹800" into a number.
 * Returns 0 if unparseable.
 */
function parseAmount(amountStr) {
  if (!amountStr) return 0;
  var cleaned = String(amountStr).replace(/[^0-9.]/g, "");
  var num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// =============================================================================
// ITEM MATCHING
// =============================================================================

/**
 * Matches billed medicine items against prescribed medicines.
 * Uses fuzzy name matching via normalizeDrugName + calculateNameSimilarity.
 *
 * Returns: {
 *   matchedItems: [{ billedItem, prescribedItem, prescriptionFile, score }],
 *   unmatchedItems: [{ billedItem }],
 *   reimbursableAmount: Number,
 *   nonReimbursableAmount: Number,
 *   coveragePercentage: Number
 * }
 */
function matchMedicines(billData, prescriptions) {
  var billedItems = billData.billedItems || [];
  var result = {
    matchedItems: [],
    unmatchedItems: [],
    reimbursableAmount: 0,
    nonReimbursableAmount: 0,
    coveragePercentage: 0
  };

  if (billedItems.length === 0) return result;

  for (var i = 0; i < billedItems.length; i++) {
    var billedItem = billedItems[i];
    var billedNorm = normalizeDrugName(billedItem.name);
    var bestMatch = null;
    var bestScore = 0;
    var bestRx = null;

    // Search across all prescriptions
    for (var p = 0; p < prescriptions.length; p++) {
      var rx = prescriptions[p];
      var prescribedItems = rx.prescribedItems || [];

      for (var j = 0; j < prescribedItems.length; j++) {
        var prescribedItem = prescribedItems[j];
        // Only match medicines
        if (prescribedItem.type !== "medicine") continue;

        var prescribedNorm = normalizeDrugName(prescribedItem.name);
        var score = calculateNameSimilarity(billedNorm, prescribedNorm);

        if (score >= 0.7 && score > bestScore) {
          bestScore = score;
          bestMatch = prescribedItem;
          bestRx = rx;
        }
      }
    }

    var itemAmount = parseAmount(billedItem.price);

    if (bestMatch) {
      result.matchedItems.push({
        billedItem: billedItem,
        prescribedItem: bestMatch,
        prescriptionFile: bestRx.fileName || "Unknown",
        score: bestScore
      });
      result.reimbursableAmount += itemAmount;
    } else {
      result.unmatchedItems.push({
        billedItem: billedItem
      });
      result.nonReimbursableAmount += itemAmount;
    }
  }

  var total = result.reimbursableAmount + result.nonReimbursableAmount;
  result.coveragePercentage = total > 0
    ? Math.round((result.reimbursableAmount / total) * 100)
    : 0;

  return result;
}

/**
 * Matches billed or reported tests against prescribed tests.
 * Works for Diagnostics Bills, Lab Reports, and Radiology Reports.
 *
 * Returns same shape as matchMedicines().
 */
function matchTests(docData, prescriptions) {
  // Tests can come from billedItems (Diagnostics Bill) or reportedTests (Lab/Radiology Report)
  var testItems = docData.billedItems || docData.reportedTests || [];
  var result = {
    matchedItems: [],
    unmatchedItems: [],
    reimbursableAmount: 0,
    nonReimbursableAmount: 0,
    coveragePercentage: 0
  };

  if (testItems.length === 0) return result;

  for (var i = 0; i < testItems.length; i++) {
    var testItem = testItems[i];
    var testNorm = normalizeDrugName(testItem.name);
    var bestMatch = null;
    var bestScore = 0;
    var bestRx = null;

    for (var p = 0; p < prescriptions.length; p++) {
      var rx = prescriptions[p];
      var prescribedItems = rx.prescribedItems || [];

      for (var j = 0; j < prescribedItems.length; j++) {
        var prescribedItem = prescribedItems[j];
        // Only match tests
        if (prescribedItem.type !== "test") continue;

        var prescribedNorm = normalizeDrugName(prescribedItem.name);
        var score = calculateNameSimilarity(testNorm, prescribedNorm);

        if (score >= 0.7 && score > bestScore) {
          bestScore = score;
          bestMatch = prescribedItem;
          bestRx = rx;
        }
      }
    }

    var itemAmount = parseAmount(testItem.price);

    if (bestMatch) {
      result.matchedItems.push({
        billedItem: testItem,
        prescribedItem: bestMatch,
        prescriptionFile: bestRx.fileName || "Unknown",
        score: bestScore
      });
      result.reimbursableAmount += itemAmount;
    } else {
      result.unmatchedItems.push({
        billedItem: testItem
      });
      result.nonReimbursableAmount += itemAmount;
    }
  }

  var total = result.reimbursableAmount + result.nonReimbursableAmount;
  result.coveragePercentage = total > 0
    ? Math.round((result.reimbursableAmount / total) * 100)
    : 0;

  return result;
}

/**
 * Matches a Consultation Bill to prescriptions by date proximity (±1 day).
 * Returns a matchResult with the linked prescription, if any.
 */
function matchByDate(consultData, prescriptions) {
  var ONE_DAY_MS = 24 * 60 * 60 * 1000;
  var consultDate = parseDate(consultData.documentDate);
  var bestMatch = null;
  var bestDiff = Infinity;

  for (var p = 0; p < prescriptions.length; p++) {
    var rx = prescriptions[p];
    var rxDate = parseDate(rx.documentDate);
    var diff = Math.abs(consultDate - rxDate);

    if (diff <= ONE_DAY_MS && diff < bestDiff) {
      bestDiff = diff;
      bestMatch = rx;
    }
  }

  var totalAmount = parseAmount(consultData.amount);

  if (bestMatch) {
    return {
      matchedItems: [{
        billedItem: { name: "Consultation Fee", price: consultData.amount },
        prescribedItem: { name: "Doctor Visit", type: "consultation" },
        prescriptionFile: bestMatch.fileName || "Unknown",
        score: 1.0
      }],
      unmatchedItems: [],
      reimbursableAmount: totalAmount,
      nonReimbursableAmount: 0,
      coveragePercentage: 100
    };
  }

  return {
    matchedItems: [],
    unmatchedItems: [{ billedItem: { name: "Consultation Fee", price: consultData.amount } }],
    reimbursableAmount: 0,
    nonReimbursableAmount: totalAmount,
    coveragePercentage: 0
  };
}

// =============================================================================
// CORE LINKAGE ENGINE
// =============================================================================

/**
 * Links a single non-prescription document to its matching prescription(s).
 * Dispatches to the correct matcher based on document category.
 *
 * Returns: matchResult object (from matchMedicines/matchTests/matchByDate),
 *          or null if the category doesn't need linking.
 */
function linkToPrescription(fileData, prescriptions) {
  if (!fileData || !prescriptions || prescriptions.length === 0) {
    return {
      matchedItems: [],
      unmatchedItems: [],
      reimbursableAmount: 0,
      nonReimbursableAmount: parseAmount(fileData.amount),
      coveragePercentage: 0,
      status: "NO_PRESCRIPTION"
    };
  }

  var matchResult;

  switch (fileData.category) {
    case "Medicine Bill":
    case "Pharmacy Receipt":
      matchResult = matchMedicines(fileData, prescriptions);
      break;

    case "Diagnostics Bill":
    case "Lab Report":
    case "Radiology Report":
      matchResult = matchTests(fileData, prescriptions);
      break;

    case "Consultation Bill":
      matchResult = matchByDate(fileData, prescriptions);
      break;

    case "Discharge Summary":
    case "Hospital Bill":
      // These are always linked to the claim (if a prescription exists)
      var totalAmount = parseAmount(fileData.amount);
      matchResult = {
        matchedItems: [{
          billedItem: { name: fileData.category, price: fileData.amount },
          prescribedItem: { name: "Hospitalization", type: "treatment" },
          prescriptionFile: prescriptions[0].fileName || "Unknown",
          score: 1.0
        }],
        unmatchedItems: [],
        reimbursableAmount: totalAmount,
        nonReimbursableAmount: 0,
        coveragePercentage: 100
      };
      break;

    default:
      // Doctor Notes, Insurance Form, Other — no matching needed
      return null;
  }

  // Set status based on results
  if (matchResult.matchedItems.length > 0 && matchResult.unmatchedItems.length === 0) {
    matchResult.status = "FULLY_COVERED";
  } else if (matchResult.matchedItems.length > 0 && matchResult.unmatchedItems.length > 0) {
    matchResult.status = "PARTIALLY_COVERED";
  } else {
    matchResult.status = "NOT_COVERED";
  }

  return matchResult;
}

// =============================================================================
// CLAIM COMPLETENESS VALIDATION
// =============================================================================

/**
 * Validates whether a claim has everything needed for insurance submission.
 * Runs 5 rules and returns { isComplete, issues, summary }.
 */
function checkClaimCompleteness(allClaimFiles) {
  var issues = [];
  var prescriptions = [];
  var bills = [];
  var reports = [];
  var hasConsultationBill = false;

  // Separate files by category
  for (var i = 0; i < allClaimFiles.length; i++) {
    var f = allClaimFiles[i];
    switch (f.category) {
      case "Prescription":
        prescriptions.push(f);
        break;
      case "Medicine Bill":
      case "Pharmacy Receipt":
      case "Diagnostics Bill":
      case "Hospital Bill":
        bills.push(f);
        break;
      case "Lab Report":
      case "Radiology Report":
        reports.push(f);
        break;
      case "Consultation Bill":
        hasConsultationBill = true;
        bills.push(f);
        break;
    }
  }

  // RULE 1: Every claim MUST have at least one Prescription
  if (prescriptions.length === 0) {
    issues.push("❌ No prescription found — claim cannot be filed for reimbursement");
  }

  // RULE 2: Every Medicine Bill should have items matching a prescription
  for (var i = 0; i < allClaimFiles.length; i++) {
    var f = allClaimFiles[i];
    if ((f.category === "Medicine Bill" || f.category === "Pharmacy Receipt") && f.matchResult) {
      if (f.matchResult.unmatchedItems && f.matchResult.unmatchedItems.length > 0) {
        var names = f.matchResult.unmatchedItems.map(function(u) { return u.billedItem.name; }).join(", ");
        issues.push("⚠️ " + f.category + " has items not in any prescription: " + names);
      }
    }
  }

  // RULE 3: Every Diagnostics Bill / Lab Report / Radiology Report should match
  for (var i = 0; i < allClaimFiles.length; i++) {
    var f = allClaimFiles[i];
    if ((f.category === "Diagnostics Bill" || f.category === "Lab Report" || f.category === "Radiology Report") && f.matchResult) {
      if (f.matchResult.unmatchedItems && f.matchResult.unmatchedItems.length > 0) {
        var names = f.matchResult.unmatchedItems.map(function(u) { return u.billedItem.name; }).join(", ");
        issues.push("⚠️ " + f.category + " has tests not in any prescription: " + names);
      }
    }
  }

  // RULE 4: Every prescribed item should have a supporting document
  if (prescriptions.length > 0) {
    // Collect all matched prescribed items across all documents
    var coveredPrescribedItems = {};
    for (var i = 0; i < allClaimFiles.length; i++) {
      var f = allClaimFiles[i];
      if (f.matchResult && f.matchResult.matchedItems) {
        for (var j = 0; j < f.matchResult.matchedItems.length; j++) {
          var m = f.matchResult.matchedItems[j];
          if (m.prescribedItem && m.prescribedItem.name) {
            coveredPrescribedItems[normalizeDrugName(m.prescribedItem.name)] = true;
          }
        }
      }
    }

    // Check each prescribed item
    for (var p = 0; p < prescriptions.length; p++) {
      var rx = prescriptions[p];
      var items = rx.prescribedItems || [];
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var normName = normalizeDrugName(item.name);
        if (!coveredPrescribedItems[normName]) {
          var docType = item.type === "medicine" ? "medicine bill" : "report/bill";
          issues.push("📋 Prescribed " + item.type + " missing " + docType + ": " + item.name);
        }
      }
    }
  }

  // RULE 5: Consultation Bill should exist for the visit
  if (prescriptions.length > 0 && !hasConsultationBill) {
    issues.push("💡 Consider adding consultation bill for completeness");
  }

  // Count critical issues (❌)
  var criticalCount = 0;
  for (var i = 0; i < issues.length; i++) {
    if (issues[i].indexOf("❌") !== -1) criticalCount++;
  }

  return {
    isComplete: criticalCount === 0,
    issues: issues,
    prescriptionCount: prescriptions.length,
    totalDocuments: allClaimFiles.length
  };
}

// =============================================================================
// PASS 2: LINKAGE ENTRY POINT
// =============================================================================

/**
 * Runs the full prescription linkage pass for a single claim folder.
 * Called after all files have been classified and organized.
 *
 * Parameters:
 *   destFolder: Root destination folder
 *   claimFolderName: Name of the claim folder to process
 *   fileDataList: Array of metadata objects for files in this claim
 *
 * Returns: { linkageResults, completeness, summary }
 */
function runPrescriptionLinkage(destFolder, claimFolderName, fileDataList) {
  Logger.log("\n=== PASS 2: Prescription Linkage for " + claimFolderName + " ===");

  // 1. Identify all prescriptions
  var prescriptions = [];
  for (var i = 0; i < fileDataList.length; i++) {
    if (fileDataList[i].category === "Prescription") {
      prescriptions.push(fileDataList[i]);
    }
  }

  Logger.log("  Found " + prescriptions.length + " prescription(s) in claim.");

  // 2. Link each non-prescription document to a prescription
  var totalReimbursable = 0;
  var totalNonReimbursable = 0;

  for (var i = 0; i < fileDataList.length; i++) {
    var fileData = fileDataList[i];

    // Skip prescriptions themselves
    if (fileData.category === "Prescription") continue;

    var matchResult = linkToPrescription(fileData, prescriptions);
    if (matchResult) {
      fileData.matchResult = matchResult;
      totalReimbursable += matchResult.reimbursableAmount;
      totalNonReimbursable += matchResult.nonReimbursableAmount;

      Logger.log("  " + fileData.fileName + " (" + fileData.category + ") → " +
                 matchResult.status +
                 " | Reimbursable: ₹" + matchResult.reimbursableAmount +
                 " | Not Reimbursable: ₹" + matchResult.nonReimbursableAmount);
    }
  }

  // 3. Check claim completeness
  var completeness = checkClaimCompleteness(fileDataList);

  Logger.log("  Claim completeness: " + (completeness.isComplete ? "✅ Complete" : "⚠️ Incomplete"));
  for (var i = 0; i < completeness.issues.length; i++) {
    Logger.log("    " + completeness.issues[i]);
  }

  var summary = {
    claimFolder: claimFolderName,
    prescriptionCount: prescriptions.length,
    totalDocuments: fileDataList.length,
    totalReimbursable: totalReimbursable,
    totalNonReimbursable: totalNonReimbursable,
    totalBilled: totalReimbursable + totalNonReimbursable,
    isComplete: completeness.isComplete,
    issues: completeness.issues
  };

  // 4. Write the enhanced report
  var claimFolders = destFolder.getFoldersByName(claimFolderName);
  if (claimFolders.hasNext()) {
    var claimFolder = claimFolders.next();
    updatePrescriptionCoverageReport(claimFolder, fileDataList, summary);
  }

  return summary;
}

// =============================================================================
// ENHANCED REPORTING (3-TAB CONSOLIDATED REPORT)
// =============================================================================

/**
 * Creates or updates the Consolidated_Report with 3 tabs:
 *   Tab 1: Claim Summary — high-level overview
 *   Tab 2: Prescription Coverage — item-level linkage
 *   Tab 3: Document List — all documents with reimbursement status
 */
function updatePrescriptionCoverageReport(claimFolder, fileDataList, summary) {
  var sheetFile;
  var files = claimFolder.getFilesByName("Consolidated_Report");

  var ss;
  if (files.hasNext()) {
    sheetFile = files.next();
    ss = SpreadsheetApp.openById(sheetFile.getId());
  } else {
    ss = SpreadsheetApp.create("Consolidated_Report");
    var file = DriveApp.getFileById(ss.getId());
    file.moveTo(claimFolder);
  }

  // ── TAB 1: CLAIM SUMMARY ──
  var summarySheet = getOrCreateSheet(ss, "Claim Summary");
  summarySheet.clear();

  var patientName = "";
  var earliestDate = "";
  var latestDate = "";
  for (var i = 0; i < fileDataList.length; i++) {
    if (fileDataList[i].patientName && !patientName) {
      patientName = fileDataList[i].patientName;
    }
    if (fileDataList[i].documentDate) {
      if (!earliestDate || fileDataList[i].documentDate < earliestDate) {
        earliestDate = fileDataList[i].documentDate;
      }
      if (!latestDate || fileDataList[i].documentDate > latestDate) {
        latestDate = fileDataList[i].documentDate;
      }
    }
  }

  var summaryData = [
    ["CLAIM SUMMARY", ""],
    ["", ""],
    ["Patient Name", patientName],
    ["Claim Period", earliestDate + " to " + latestDate],
    ["Total Documents", summary.totalDocuments],
    ["Prescriptions Found", summary.prescriptionCount],
    ["", ""],
    ["FINANCIAL SUMMARY", ""],
    ["Total Billed Amount", "₹" + summary.totalBilled],
    ["Reimbursable Amount", "₹" + summary.totalReimbursable],
    ["Non-Reimbursable Amount", "₹" + summary.totalNonReimbursable],
    ["", ""],
    ["CLAIM STATUS", summary.isComplete ? "✅ Complete" : "⚠️ Incomplete"],
    ["", ""]
  ];

  // Add issues
  if (summary.issues.length > 0) {
    summaryData.push(["ISSUES / ALERTS", ""]);
    for (var i = 0; i < summary.issues.length; i++) {
      summaryData.push([summary.issues[i], ""]);
    }
  } else {
    summaryData.push(["No issues found — claim is ready for submission.", ""]);
  }

  summarySheet.getRange(1, 1, summaryData.length, 2).setValues(summaryData);

  // Format the summary tab
  summarySheet.getRange(1, 1).setFontWeight("bold").setFontSize(14);
  summarySheet.getRange(8, 1).setFontWeight("bold").setFontSize(12);
  summarySheet.getRange(3, 1, 5, 1).setFontWeight("bold");
  summarySheet.getRange(9, 1, 3, 1).setFontWeight("bold");
  summarySheet.getRange(13, 1).setFontWeight("bold");
  summarySheet.setColumnWidth(1, 280);
  summarySheet.setColumnWidth(2, 250);

  // ── TAB 2: PRESCRIPTION COVERAGE ──
  var coverageSheet = getOrCreateSheet(ss, "Prescription Coverage");
  coverageSheet.clear();

  // Header row
  var coverageHeaders = [
    "Prescribed Item", "Type", "Prescribed By", "Doctor",
    "Supporting Doc", "Bill Amount", "Match Score", "Status"
  ];
  coverageSheet.appendRow(coverageHeaders);
  coverageSheet.getRange(1, 1, 1, coverageHeaders.length).setFontWeight("bold");
  coverageSheet.setFrozenRows(1);

  // Collect all prescribed items and their coverage
  var prescriptions = [];
  for (var i = 0; i < fileDataList.length; i++) {
    if (fileDataList[i].category === "Prescription") {
      prescriptions.push(fileDataList[i]);
    }
  }

  // Track which prescribed items are covered
  var coveredItems = {};

  // First, add all matched items from supporting documents
  for (var i = 0; i < fileDataList.length; i++) {
    var f = fileDataList[i];
    if (f.matchResult && f.matchResult.matchedItems) {
      for (var j = 0; j < f.matchResult.matchedItems.length; j++) {
        var m = f.matchResult.matchedItems[j];
        var rxItemName = m.prescribedItem ? m.prescribedItem.name : "";
        coveredItems[normalizeDrugName(rxItemName)] = true;

        coverageSheet.appendRow([
          rxItemName,
          m.prescribedItem ? (m.prescribedItem.type || "") : "",
          m.prescriptionFile || "",
          "",
          f.category + " — " + (f.fileName || ""),
          m.billedItem ? (m.billedItem.price || "") : "",
          Math.round((m.score || 0) * 100) + "%",
          "✅ Covered"
        ]);
      }
    }

    // Add unmatched (not prescribed) items
    if (f.matchResult && f.matchResult.unmatchedItems) {
      for (var j = 0; j < f.matchResult.unmatchedItems.length; j++) {
        var u = f.matchResult.unmatchedItems[j];
        coverageSheet.appendRow([
          "—",
          "—",
          "—",
          "—",
          f.category + " — " + (u.billedItem ? u.billedItem.name : "Unknown"),
          u.billedItem ? (u.billedItem.price || "") : "",
          "—",
          "⚠️ Not Prescribed"
        ]);
      }
    }
  }

  // Add prescribed items that have no supporting documents
  for (var p = 0; p < prescriptions.length; p++) {
    var rx = prescriptions[p];
    var items = rx.prescribedItems || [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!coveredItems[normalizeDrugName(item.name)]) {
        var docType = item.type === "medicine" ? "Medicine Bill" : "Report / Bill";
        coverageSheet.appendRow([
          item.name,
          item.type || "",
          rx.fileName || "",
          rx.doctorName || "",
          "— (missing " + docType + ")",
          "—",
          "—",
          "❌ Missing"
        ]);
      }
    }
  }

  // ── TAB 3: DOCUMENT LIST ──
  var docSheet = getOrCreateSheet(ss, "Document List");
  docSheet.clear();

  var docHeaders = [
    "#", "Category", "File Name", "Date", "Clinic/Hospital",
    "Doctor", "Amount", "Bill Number", "Linked Prescription",
    "Reimbursable?", "Reimb. Amount", "Notes"
  ];
  docSheet.appendRow(docHeaders);
  docSheet.getRange(1, 1, 1, docHeaders.length).setFontWeight("bold");
  docSheet.setFrozenRows(1);

  for (var i = 0; i < fileDataList.length; i++) {
    var f = fileDataList[i];
    var linkedRx = "";
    var reimbursable = "";
    var reimbAmount = "";

    if (f.category === "Prescription") {
      linkedRx = "SELF (Anchor)";
      reimbursable = "—";
      reimbAmount = "—";
    } else if (f.matchResult) {
      if (f.matchResult.status === "FULLY_COVERED") {
        reimbursable = "✅ Full";
        reimbAmount = "₹" + f.matchResult.reimbursableAmount;
      } else if (f.matchResult.status === "PARTIALLY_COVERED") {
        reimbursable = "⚠️ Partial";
        reimbAmount = "₹" + f.matchResult.reimbursableAmount + " of ₹" +
                      (f.matchResult.reimbursableAmount + f.matchResult.nonReimbursableAmount);
      } else if (f.matchResult.status === "NOT_COVERED") {
        reimbursable = "❌ No";
        reimbAmount = "₹0";
      } else if (f.matchResult.status === "NO_PRESCRIPTION") {
        reimbursable = "❌ No Rx";
        reimbAmount = "₹0";
      }

      // Find which prescription was matched
      if (f.matchResult.matchedItems && f.matchResult.matchedItems.length > 0) {
        linkedRx = f.matchResult.matchedItems[0].prescriptionFile || "";
      } else {
        linkedRx = "None";
      }
    }

    docSheet.appendRow([
      i + 1,
      f.category || "",
      f.fileName || "",
      f.documentDate || "",
      f.clinicName || "",
      f.doctorName || "",
      f.amount || "",
      f.billNumber || "",
      linkedRx,
      reimbursable,
      reimbAmount,
      f.notes || ""
    ]);
  }

  // Delete the default "Sheet1" if it still exists and we've created new tabs
  try {
    var defaultSheet = ss.getSheetByName("Sheet1");
    if (defaultSheet && ss.getSheets().length > 1) {
      ss.deleteSheet(defaultSheet);
    }
  } catch (e) {
    // Ignore — Sheet1 might not exist or might be the only sheet
  }

  Logger.log("  Updated Consolidated_Report with 3 tabs.");
}

/**
 * Gets an existing sheet by name or creates it in the spreadsheet.
 */
function getOrCreateSheet(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}
