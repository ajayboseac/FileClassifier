# Implementation Plan

---

## Problem 1: Duplicate File Detection in the Raw Folder

### The Problem

Files are uploaded to the `raw/` folder and sometimes:
- **Same-name duplicates**: The exact same file is uploaded again (same filename).
- **Content duplicates**: A different filename but the underlying content (PDF, image, etc.) is byte-for-byte identical or near-identical (e.g., re-downloaded with a `(1)` suffix).

The current `processFiles()` picks up every file in the source folder and processes them all — there is **zero duplicate detection**. This wastes Gemini API calls, creates duplicate entries in the Consolidated Report, and clutters claim folders.

### Solution Overview

Add a **Duplicate Detection Gate** as the very first step inside the `processFiles()` loop, *before* the expensive `prepareFileForLLM()` and `callLLM()` calls.

The approach is layered:

```
Layer 1: Exact filename match (cheapest)
Layer 2: Content hash (MD5) match (definitive for identical content)
Layer 3: LLM-level duplicate detection (catches near-duplicates like re-scans)
```

### Detailed Design

#### 1.1 — Duplicate Registry Sheet

Create a new Google Sheet called **`Duplicate_Registry`** in the destination root folder. This acts as the system's memory of every file it has ever processed.

**Columns:**

| Column | Description |
|--------|-------------|
| `fileId` | Google Drive file ID (unique) |
| `md5Hash` | MD5 checksum of the file content |
| `originalName` | Original filename when first processed |
| `category` | LLM-assigned category |
| `patientName` | Extracted patient name |
| `documentDate` | Extracted document date |
| `claimFolder` | Claim folder the file was moved to |
| `processedAt` | Timestamp when the file was processed |
| `billNumber` | Bill/report number extracted by LLM |

#### 1.2 — New Function: `isDuplicate(file)`

This function runs *before* any LLM call and returns `{ isDuplicate: true/false, reason: "...", existingEntry: {...} }`.

**Step-by-step logic:**

```
function isDuplicate(file, registryData) {

  // ── CHECK 1: File ID Match ──
  // If the exact same Drive file ID exists in the registry, it has already
  // been processed. This catches re-runs where the file wasn't moved.
  if (registryData has matching fileId)
    → return { isDuplicate: true, reason: "Already processed (same file ID)" }

  // ── CHECK 2: MD5 Content Hash ──
  // Google Drive provides an MD5 checksum for every file.
  // DriveApp doesn't expose it, but the Advanced Drive Service does:
  //   Drive.Files.get(file.getId()).md5Checksum
  // If two files have the same MD5, their content is identical.
  var md5 = Drive.Files.get(file.getId()).md5Checksum;
  if (registryData has matching md5Hash)
    → return { isDuplicate: true, reason: "Identical content (MD5 match)" }

  // ── CHECK 3: Filename Pattern Match (soft) ──
  // Detect common re-upload patterns:
  //   "report.pdf"  vs  "report (1).pdf"
  //   "IMG_001.jpg" vs  "IMG_001 (2).jpg"
  //   "report.pdf"  vs  "Copy of report.pdf"
  // Strip patterns like " (N)", "Copy of ", trailing numbers.
  // If normalized name exists in registry AND same date + patient:
  //   → flag as LIKELY duplicate but still process (log a warning)

  return { isDuplicate: false }
}
```

#### 1.3 — New Function: `getOrCreateDuplicateRegistry(rootFolder)`

Returns all rows from the Duplicate_Registry sheet as an array of objects. Creates the sheet if it doesn't exist.

```
function getOrCreateDuplicateRegistry(rootDestFolder) {
  // Look for existing "Duplicate_Registry" sheet in the root folder
  // If not found, create it with headers:
  //   fileId | md5Hash | originalName | category | patientName |
  //   documentDate | claimFolder | processedAt | billNumber
  // Read all existing rows into an array of objects
  // Return { sheet: SpreadsheetObject, data: [...] }
}
```

#### 1.4 — New Function: `registerProcessedFile(registrySheet, data)`

After a file is successfully processed and moved, add it to the registry.

```
function registerProcessedFile(registrySheet, data) {
  registrySheet.appendRow([
    data.fileId,
    data.md5Hash,
    data.fileName,
    data.category,
    data.patientName || "",
    data.documentDate || "",
    data.claimFolderName || "",
    new Date(),
    data.billNumber || ""
  ]);
}
```

#### 1.5 — Handling Detected Duplicates

When a duplicate is found:
1. **Log it** — Add an entry to a `Duplicate_Log` sheet (or a tab in the Classification_Log) with: timestamp, filename, reason, matched-to file.
2. **Move to a `_duplicates/` folder** — Instead of deleting (risky), move the duplicate file to a `_duplicates/` subfolder in the destination root. This lets the user review and manually delete later.
3. **Skip LLM processing** — Do NOT spend an API call on it.

#### 1.6 — Changes to `processFiles()`

```javascript
function processFiles() {
  var sourceFolder = DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID);
  var destFolder = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID);

  // NEW: Load duplicate registry
  var registry = getOrCreateDuplicateRegistry(destFolder);

  var existingClaims = getExistingClaimsMetadata(destFolder);
  var fileDataList = [];
  var files = sourceFolder.getFiles();

  while (files.hasNext()) {
    var file = files.next();
    Logger.log("Processing file: " + file.getName());

    // NEW: Duplicate check BEFORE any LLM call
    var dupCheck = isDuplicate(file, registry.data);
    if (dupCheck.isDuplicate) {
      Logger.log("  -> DUPLICATE DETECTED: " + dupCheck.reason);
      handleDuplicate(file, destFolder, dupCheck);
      continue; // Skip this file entirely
    }

    try {
      var fileInput = prepareFileForLLM(file);
      // ... rest of existing logic ...

      // NEW: Store MD5 hash in metadata for later registration
      metadata.md5Hash = Drive.Files.get(file.getId()).md5Checksum;

    } catch (e) { ... }
  }

  // ... existing claim matching and organization ...

  // After successful processing:
  for (var i = 0; i < fileDataList.length; i++) {
    // ... existing move/organize/log ...

    // NEW: Register in duplicate registry
    registerProcessedFile(registry.sheet, fileDataList[i]);
  }
}
```

#### 1.7 — Edge Cases

| Scenario | Handling |
|----------|----------|
| Same file re-uploaded before the trigger runs | Both copies exist in raw; first one processes, second is caught by MD5 check |
| File renamed, same content | Caught by MD5 hash match |
| Same document scanned twice (slightly different) | NOT caught by MD5 (different bytes). Could add LLM-level billNumber matching in Phase 2 |
| Legitimate same-name files for different patients | NOT flagged — MD5 will differ because content differs |
| Google Docs (no MD5) | `md5Checksum` is null for Google-native files. Fall back to content text hash using `Utilities.computeDigest()` |

### Implementation Order

1. **`getOrCreateDuplicateRegistry()`** — Create the registry sheet
2. **`isDuplicate()`** — Core duplicate detection logic
3. **`handleDuplicate()`** — Move to `_duplicates/`, log
4. **`registerProcessedFile()`** — Record each processed file
5. **Modify `processFiles()`** — Wire everything together
6. **Backfill existing files** — One-time script to populate the registry with files already in claim folders

---

## Problem 2: Prescription-Centric Insurance Reimbursement

### The Problem

Health insurance reimburses expenses **only if a doctor has prescribed them**. The current system classifies and organizes files independently — a Medicine Bill is filed in the claim folder without checking whether there is a corresponding Prescription that lists those medicines. Similarly, a Lab Report or Diagnostics Bill may exist without a prescription ordering those tests.

**The insurance claim needs to be built around the Prescription as the anchor document.** Without this linkage, the claim package is incomplete and may be rejected.

### Solution Overview: Prescription as the Anchor

Restructure the system so that every claim's Consolidated Report clearly shows the **Prescription → Supporting Document** linkage.

```
🏥 Prescription (ANCHOR)
 ├── 💊 Medicine Bill     (prescribed medicines → purchased medicines)
 ├── 🧪 Diagnostics Bill  (prescribed tests → billed tests)
 ├── 📋 Lab Report        (prescribed tests → result reports)
 ├── 📋 Radiology Report  (prescribed imaging → result reports)
 └── 💳 Consultation Bill  (the visit itself)
```

### 📊 Flow Diagram

> **Interactive diagram:** Open [`prescription-linkage-diagram.html`](./prescription-linkage-diagram.html) in a browser for the full visual flow.

#### wEnd-to-End Flow (6 Phases)

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  PASS 1 — Existing Classification (Enhanced)                                    ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║                                                                                  ║
║  ┌─────────────────────────────────────────────────────────────────┐              ║
║  │ PHASE 1: ENHANCED LLM EXTRACTION                               │              ║
║  │                                                                 │              ║
║  │  buildClassificationPrompt()  ← Modified to extract line items  │              ║
║  │                                                                 │              ║
║  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │              ║
║  │  │ Prescription │  │ Medicine Bill│  │ Lab/Radiology Report │   │              ║
║  │  │              │  │              │  │                      │   │              ║
║  │  │ prescribedI- │  │ billedItems: │  │ reportedTests:       │   │              ║
║  │  │ tems: [...]  │  │ [...]        │  │ [...]                │   │              ║
║  │  │              │  │              │  │                      │   │              ║
║  │  │ • name       │  │ • name       │  │ • name               │   │              ║
║  │  │ • type       │  │ • quantity   │  │                      │   │              ║
║  │  │ • dosage     │  │ • price      │  │                      │   │              ║
║  │  └──────────────┘  └──────────────┘  └──────────────────────┘   │              ║
║  └─────────────────────────────────────────────────────────────────┘              ║
║                                      │                                            ║
║                                      ▼                                            ║
║                     Files classified, organized into claim folders                 ║
║                                                                                  ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║  PASS 2 — Prescription Linkage & Validation (NEW)                                ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║                                      │                                            ║
║                                      ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────┐              ║
║  │ PHASE 2: IDENTIFY ANCHOR PRESCRIPTIONS                          │              ║
║  │                                                                 │              ║
║  │  For each claim folder touched in this batch:                   │              ║
║  │    1. Find all files where category === "Prescription"          │              ║
║  │    2. Aggregate all prescribedItems into two lists:             │              ║
║  │       • Medicines (type: "medicine")                            │              ║
║  │       • Tests (type: "test")                                    │              ║
║  │    3. If NO prescriptions found → flag entire claim             │              ║
║  └─────────────────────────────────────────────────────────────────┘              ║
║                                      │                                            ║
║                          ┌───────────┼───────────┐                                ║
║                          ▼           ▼           ▼                                ║
║  ┌─────────────────────────────────────────────────────────────────┐              ║
║  │ PHASE 3: PRESCRIPTION ↔ DOCUMENT MATCHING                      │              ║
║  │                                                                 │              ║
║  │  For each non-prescription document:                            │              ║
║  │                                                                 │              ║
║  │  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────┐   │              ║
║  │  │ Medicine Bill    │  │ Diagnostics Bill │  │ Consultation │   │              ║
║  │  │                  │  │ Lab Report       │  │ Bill         │   │              ║
║  │  │ matchMedicines() │  │ Radiology Report │  │              │   │              ║
║  │  │                  │  │                  │  │ matchByDate()│   │              ║
║  │  │ billedItems vs   │  │ matchTests()     │  │              │   │              ║
║  │  │ prescribed       │  │                  │  │ Same date    │   │              ║
║  │  │ medicines        │  │ billedItems /    │  │ ± 1 day      │   │              ║
║  │  │                  │  │ reportedTests vs │  │              │   │              ║
║  │  │ Fuzzy match ≥70% │  │ prescribed tests │  │              │   │              ║
║  │  └─────────────────┘  └──────────────────┘  └──────────────┘   │              ║
║  │                                                                 │              ║
║  │  Uses existing: calculateNameSimilarity() + levenshteinDist()   │              ║
║  └─────────────────────────────────────────────────────────────────┘              ║
║                                      │                                            ║
║                                      ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────┐              ║
║  │ PHASE 4: REIMBURSEMENT CLASSIFICATION                           │              ║
║  │                                                                 │              ║
║  │             ┌──────────────────────────┐                        │              ║
║  │             │ Is item prescribed by a  │                        │              ║
║  │             │ doctor?                  │                        │              ║
║  │             └────┬─────────┬───────────┘                        │              ║
║  │                  │         │          │                          │              ║
║  │      ┌───────────┘    ┌────┘    ┌─────┘                         │              ║
║  │      ▼                ▼         ▼                               │              ║
║  │  ╔═══════════╗  ╔══════════╗  ╔════════════╗                    │              ║
║  │  ║ ✅ REIMB- ║  ║ ❌ NOT   ║  ║ ⚠️ INCOM- ║                    │              ║
║  │  ║ URSABLE   ║  ║ REIMB-   ║  ║ PLETE      ║                    │              ║
║  │  ║           ║  ║ URSABLE  ║  ║            ║                    │              ║
║  │  ║ Prescribed║  ║ Billed   ║  ║ Prescribed ║                    │              ║
║  │  ║ + Billed  ║  ║ but NOT  ║  ║ but NO     ║                    │              ║
║  │  ║           ║  ║ prescribed║  ║ bill/report║                    │              ║
║  │  ╚═══════════╝  ╚══════════╝  ╚════════════╝                    │              ║
║  └─────────────────────────────────────────────────────────────────┘              ║
║                                      │                                            ║
║                                      ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────┐              ║
║  │ PHASE 5: CLAIM COMPLETENESS VALIDATION                          │              ║
║  │                                                                 │              ║
║  │  checkClaimCompleteness() — 5 Rules:                            │              ║
║  │                                                                 │              ║
║  │  Rule 1: ≥1 Prescription exists               → ✅ / ❌        │              ║
║  │  Rule 2: All billed medicines are prescribed   → ✅ / ⚠️       │              ║
║  │  Rule 3: All billed tests are prescribed       → ✅ / ⚠️       │              ║
║  │  Rule 4: All prescribed items have bills       → ✅ / ⚠️       │              ║
║  │  Rule 5: Consultation Bill exists              → ✅ / 💡       │              ║
║  │                                                                 │              ║
║  │  Output:                                                        │              ║
║  │    • Total Billed: ₹4,500                                      │              ║
║  │    • Reimbursable: ₹3,800  ← Only prescribed items             │              ║
║  │    • Non-Reimbursable: ₹700  ← Items not in any prescription   │              ║
║  │    • Claim Status: ✅ Complete / ⚠️ Incomplete                  │              ║
║  └─────────────────────────────────────────────────────────────────┘              ║
║                                      │                                            ║
║                                      ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────┐              ║
║  │ PHASE 6: ENHANCED CONSOLIDATED REPORT (3 Tabs)                  │              ║
║  │                                                                 │              ║
║  │  ┌─────────────────┬────────────────────┬─────────────────┐     │              ║
║  │  │ Tab 1:          │ Tab 2:             │ Tab 3:          │     │              ║
║  │  │ Claim Summary   │ Prescription       │ Document List   │     │              ║
║  │  │                 │ Coverage           │                 │     │              ║
║  │  │ • Patient       │                    │ • All files     │     │              ║
║  │  │ • Period        │ • Each prescribed  │ • With linkage  │     │              ║
║  │  │ • Total billed  │   item → status    │   status        │     │              ║
║  │  │ • Reimbursable  │ • ✅ Covered       │ • Reimbursable? │     │              ║
║  │  │ • Non-Reimb.    │ • ❌ Missing       │                 │     │              ║
║  │  │ • Completeness  │ • ⚠️ Not Prescribed│                 │     │              ║
║  │  └─────────────────┴────────────────────┴─────────────────┘     │              ║
║  └─────────────────────────────────────────────────────────────────┘              ║
║                                                                                  ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```


### Detailed Design

#### 2.1 — Enhanced LLM Extraction

Modify `buildClassificationPrompt()` to extract **structured line items** from prescriptions and bills:

**New fields to extract (added to JSON output):**

```json
{
  "category": "Prescription",
  "patientName": "Ajay Bose",
  "documentDate": "2025-03-15",
  "doctorName": "Dr. Sharma",
  "clinicName": "Apollo Clinic",

  // NEW: Structured line items
  "prescribedItems": [
    { "name": "Amoxicillin 500mg", "type": "medicine", "dosage": "1-0-1", "days": 5 },
    { "name": "Complete Blood Count", "type": "test" },
    { "name": "Ultrasound Abdomen", "type": "test" }
  ]
}
```

For **bills** (Medicine Bill, Diagnostics Bill):
```json
{
  "category": "Medicine Bill",
  "billedItems": [
    { "name": "Amoxicillin 500mg", "quantity": 10, "price": "150 INR" },
    { "name": "Paracetamol 650mg", "quantity": 5, "price": "30 INR" }
  ]
}
```

For **reports** (Lab Report, Radiology Report):
```json
{
  "category": "Lab Report",
  "reportedTests": [
    { "name": "Complete Blood Count" },
    { "name": "Lipid Panel" }
  ]
}
```

#### 2.2 — New Function: `linkToPrescription(fileData, claimFiles)`

After classification, for every non-prescription document, find its matching prescription(s) within the same claim folder.

```
function linkToPrescription(currentFile, allFilesInClaim) {
  // 1. Get all Prescriptions in this claim folder
  var prescriptions = allFilesInClaim.filter(f => f.category === "Prescription");

  if (prescriptions.length === 0) {
    currentFile.prescriptionLink = "NO_PRESCRIPTION_FOUND";
    currentFile.reimbursementStatus = "⚠️ Not Reimbursable - No prescription";
    return;
  }

  // 2. Match based on category type
  switch (currentFile.category) {
    case "Medicine Bill":
      // Match billedItems against prescribedItems where type === "medicine"
      matchMedicines(currentFile, prescriptions);
      break;

    case "Diagnostics Bill":
    case "Lab Report":
    case "Radiology Report":
      // Match billedItems/reportedTests against prescribedItems where type === "test"
      matchTests(currentFile, prescriptions);
      break;

    case "Consultation Bill":
      // Always linkable to the prescription from the same visit (same date ± 1 day)
      matchByDate(currentFile, prescriptions);
      break;
  }
}
```

#### 2.3 — Item Matching Logic

**`matchMedicines(bill, prescriptions)`**

```
For each item in bill.billedItems:
  For each prescription in prescriptions:
    For each item in prescription.prescribedItems (where type === "medicine"):
      - Normalize both names (lowercase, remove strengths like "500mg", strip spaces)
      - Use fuzzy string matching (existing calculateNameSimilarity)
      - If similarity >= 0.7 → MATCH
      - Record: { billedItem, prescribedItem, prescriptionFileId, matchScore }

  If no match found → flag as "Not Prescribed"

bill.matchResult = {
  matchedItems: [...],
  unmatchedItems: [...],  // These are NOT reimbursable
  coveragePercentage: matched / total * 100,
  reimbursableAmount: sum of matched items' prices,
  nonReimbursableAmount: sum of unmatched items' prices
}
```

**`matchTests(report, prescriptions)`**

```
Same logic but matching reportedTests / billedItems against
prescribedItems where type === "test".
```

#### 2.4 — Enhanced Consolidated Report

The Consolidated Report sheet gets major upgrades to become the **Claim Summary**:

**Tab 1: Claim Summary** (New)

| Field | Value |
|-------|-------|
| Patient Name | Ajay Bose |
| Claim Period | 2025-03-15 to 2025-03-22 |
| Total Documents | 6 |
| Total Billed Amount | ₹4,500 |
| **Reimbursable Amount** | **₹3,800** |
| Non-Reimbursable Amount | ₹700 |
| Prescriptions Found | 1 |
| Claim Completeness | ✅ Complete / ⚠️ Incomplete |

**Tab 2: Prescription Coverage** (New)

| Prescribed Item | Type | Prescribed By | Supporting Doc | Bill Amount | Status |
|-----------------|------|---------------|----------------|-------------|--------|
| Amoxicillin 500mg | Medicine | Dr. Sharma | Medicine Bill #1234 | ₹150 | ✅ Covered |
| Complete Blood Count | Test | Dr. Sharma | Lab Report #5678 | ₹800 | ✅ Covered |
| Ultrasound Abdomen | Test | Dr. Sharma | — | — | ❌ Missing |
| — | — | — | Paracetamol (Bill #1234) | ₹30 | ⚠️ Not Prescribed |

**Tab 3: Document List** (Enhanced existing)

| # | Category | File Name | Date | Clinic | Amount | Linked Prescription | Reimbursable? |
|---|----------|-----------|------|--------|--------|---------------------|---------------|
| 1 | Prescription | Prescription_rx.pdf | 2025-03-15 | Apollo | — | SELF | — |
| 2 | Medicine Bill | Medicine Bill_bill.jpg | 2025-03-15 | MedPlus | ₹180 | Prescription_rx.pdf | ✅ Partial (₹150) |
| 3 | Lab Report | Lab Report_cbc.pdf | 2025-03-16 | SRL | ₹800 | Prescription_rx.pdf | ✅ Full |
| 4 | Diagnostics Bill | Diagnostics Bill_... | 2025-03-16 | SRL | ₹800 | Prescription_rx.pdf | ✅ Full |

#### 2.5 — Claim Completeness Check

New function that validates whether a claim has everything needed for insurance submission.

```
function checkClaimCompleteness(claimFiles) {
  var issues = [];

  // RULE 1: Every claim MUST have at least one Prescription
  if (no prescriptions)
    issues.push("❌ No prescription found — claim cannot be filed");

  // RULE 2: Every Medicine Bill should have prescribed medicines
  for each medicine bill:
    if (unmatched items exist)
      issues.push("⚠️ Medicine Bill has items not in any prescription");

  // RULE 3: Every Diagnostics Bill / Lab Report should have prescribed tests
  for each diagnostics/lab/radiology doc:
    if (not matched to any prescribed test)
      issues.push("⚠️ Test/Report not found in any prescription");

  // RULE 4: Every prescribed item should have a supporting document
  for each prescription:
    for each prescribed medicine:
      if (no matching Medicine Bill)
        issues.push("📋 Prescribed medicine missing bill: " + name);
    for each prescribed test:
      if (no matching Lab Report or Diagnostics Bill)
        issues.push("📋 Prescribed test missing report/bill: " + name);

  // RULE 5: Consultation Bill should exist for the visit
  if (has prescription but no consultation bill)
    issues.push("💡 Consider adding consultation bill for completeness");

  return {
    isComplete: issues.filter(i => i.startsWith("❌")).length === 0,
    issues: issues
  };
}
```

#### 2.6 — Changes to `processFiles()` Flow

The main flow changes to a **two-pass** approach:

```
PASS 1 (Existing + Modified): Classify & Organize
  - For each file → LLM classify (with enhanced extraction)
  - Match to claim → Move to folder
  - Register in duplicate registry

PASS 2 (NEW): Prescription Linkage & Claim Validation
  - For each claim folder that was touched in this batch:
    1. Load all processed files metadata from the Consolidated Report
    2. Identify all Prescriptions
    3. For each non-prescription doc: run linkToPrescription()
    4. Run checkClaimCompleteness()
    5. Update the Consolidated Report with linkage + completeness info
    6. Log any issues to Classification_Log
```

#### 2.7 — Updated Prompt for Enhanced Extraction

The `buildClassificationPrompt()` function gets these additions:

```
ADDITIONAL EXTRACTION RULES:

If category is "Prescription":
  Extract "prescribedItems" - an array of objects:
  - name: Medicine/test name exactly as written
  - type: "medicine" or "test"
  - dosage: dosage instructions (if medicine), null otherwise
  - days: number of days prescribed (if medicine), null otherwise

If category is "Medicine Bill" or "Pharmacy Receipt":
  Extract "billedItems" - an array of objects:
  - name: Medicine name exactly as written
  - quantity: number of units
  - price: price as string with currency (e.g., "150 INR")

If category is "Diagnostics Bill":
  Extract "billedItems" - an array of objects:
  - name: Test name exactly as written
  - price: price as string with currency

If category is "Lab Report" or "Radiology Report":
  Extract "reportedTests" - an array of objects:
  - name: Test name exactly as written
```

### Implementation Order

1. **Modify `buildClassificationPrompt()`** — Add the structured item extraction rules
2. **Modify `parseAndValidateLLMResponse()`** — Validate the new fields (arrays)
3. **Create `linkToPrescription()`** — Core item matching engine
4. **Create `matchMedicines()` / `matchTests()`** — Fuzzy item matchers
5. **Create `checkClaimCompleteness()`** — Claim validation
6. **Upgrade `updateConsolidatedSheet()`** — Multi-tab report with prescription coverage
7. **Modify `processFiles()`** — Add Pass 2 for linkage
8. **Test** — Run with a sample claim folder containing prescription + bills

---

## Dependency Between the Two Features

These two problems are **independent** and can be implemented in any order. However, for the best development flow:

```
Recommended order:
  1. ✅ Problem 1 (Duplicate Detection) — Simpler, standalone, immediately useful
  2. ✅ Problem 2 (Prescription Linkage) — More complex, builds on a cleaner pipeline
```

The duplicate detection from Problem 1 ensures that Problem 2 doesn't have to deal with duplicate entries when performing prescription matching.

---

## Summary of New Functions

| Function | Problem | Purpose |
|----------|---------|---------|
| `getOrCreateDuplicateRegistry()` | 1 | Create/load the dedup registry |
| `isDuplicate()` | 1 | Check file against registry |
| `handleDuplicate()` | 1 | Move to `_duplicates/`, log |
| `registerProcessedFile()` | 1 | Record processed file in registry |
| `linkToPrescription()` | 2 | Link a doc to its prescription |
| `matchMedicines()` | 2 | Fuzzy-match medicines between prescription & bill |
| `matchTests()` | 2 | Fuzzy-match tests between prescription & report/bill |
| `checkClaimCompleteness()` | 2 | Validate a claim has all needed docs |

## Modified Functions

| Function | Changes |
|----------|---------|
| `processFiles()` | Add duplicate gate + Pass 2 for linkage |
| `buildClassificationPrompt()` | Add structured item extraction |
| `parseAndValidateLLMResponse()` | Validate new array fields |
| `updateConsolidatedSheet()` | Multi-tab report with prescription coverage |

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `Code.gs` | Modify | Add duplicate detection, enhanced prompt, prescription linkage |
| `Config.gs` | Modify | Add `ENABLE_DUPLICATE_DETECTION: true`, `ENABLE_PRESCRIPTION_LINKAGE: true` |
| `DuplicateDetection.gs` | Create | Standalone module for duplicate detection functions |
| `PrescriptionLinkage.gs` | Create | Standalone module for prescription linkage functions |
