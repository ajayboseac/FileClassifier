# TODO: Prescription-Centric Reimbursement (Problem 2)

## Status: ✅ Complete

---

### Tasks

- [x] **1. Create `PrescriptionLinkage.gs`** — New file with all prescription linkage functions
  - [x] 1.1 `normalizeDrugName(name)` — Normalize medicine/test names for matching
  - [x] 1.2 `parseAmount(amountStr)` — Parse currency strings to numbers
  - [x] 1.3 `matchMedicines(bill, prescriptions)` — Fuzzy-match billed medicines against prescribed
  - [x] 1.4 `matchTests(doc, prescriptions)` — Fuzzy-match billed/reported tests against prescribed
  - [x] 1.5 `matchByDate(consultBill, prescriptions)` — Match consultation bills by date proximity
  - [x] 1.6 `linkToPrescription(fileData, prescriptions)` — Core matching engine dispatch
  - [x] 1.7 `checkClaimCompleteness(allClaimFiles)` — 5-rule claim validator
  - [x] 1.8 `runPrescriptionLinkage(destFolder, claimFolderName, fileDataList)` — Pass 2 entry point
  - [x] 1.9 `updatePrescriptionCoverageReport(claimFolder, fileDataList, summary)` — 3-tab report
  - [x] 1.10 `getOrCreateSheet(spreadsheet, sheetName)` — Sheet tab helper

- [x] **2. Modify `buildClassificationPrompt()` in `Code.gs`**
  - [x] 2.1 Add structured item extraction rules (prescribedItems, billedItems, reportedTests)
  - [x] 2.2 Add category-specific examples (Prescription, Medicine Bill, Lab Report)

- [x] **3. Modify `parseAndValidateLLMResponse()` in `Code.gs`**
  - [x] 3.1 Validate prescribedItems array (Prescription)
  - [x] 3.2 Validate billedItems array (Medicine Bill, Pharmacy Receipt, Diagnostics Bill)
  - [x] 3.3 Validate reportedTests array (Lab Report, Radiology Report)
  - [x] 3.4 Log item counts for debugging

- [x] **4. Modify `processFiles()` in `Code.gs`**
  - [x] 4.1 Conditionally skip basic Consolidated_Report when linkage is ON
  - [x] 4.2 Track which claim folders were touched in this batch
  - [x] 4.3 Add Pass 2: run prescription linkage for each touched claim folder
  - [x] 4.4 Graceful fallback to basic report on linkage errors

- [x] **5. Update `Config.gs`**
  - [x] 5.1 Add `ENABLE_PRESCRIPTION_LINKAGE: true` flag

---

### Progress Log

| Time | Update |
|------|--------|
| 2026-03-06 18:34 | TODO created, starting implementation |
| 2026-03-06 18:36 | ✅ Task 1 complete — `PrescriptionLinkage.gs` created (775 lines, 10 functions) |
| 2026-03-06 18:38 | ✅ Task 2 complete — `buildClassificationPrompt()` enhanced with item extraction |
| 2026-03-06 18:39 | ✅ Task 3 complete — `parseAndValidateLLMResponse()` validates new array fields |
| 2026-03-06 18:40 | ✅ Task 4 complete — `processFiles()` has Pass 2 prescription linkage |
| 2026-03-06 18:41 | ✅ Task 5 complete — `Config.gs` has `ENABLE_PRESCRIPTION_LINKAGE` flag |
| 2026-03-06 18:41 | 🎉 Implementation complete! |

---

### Files Changed

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `PrescriptionLinkage.gs` | **Created** | 775 | 10 functions for matching, validation, and reporting |
| `Code.gs` | **Modified** | +65 | Enhanced prompt, array validation, Pass 2 wiring |
| `Config.gs` | **Modified** | +5 | Added `ENABLE_PRESCRIPTION_LINKAGE` flag |

### New Google Drive Artifacts (created at runtime)

| Artifact | Location | Description |
|----------|----------|-------------|
| `Consolidated_Report` (enhanced) | Each claim folder | 3-tab report: Claim Summary, Prescription Coverage, Document List |

### New Functions Summary

| Function | File | Purpose |
|----------|------|---------|
| `normalizeDrugName()` | PrescriptionLinkage.gs | Strips dosage, strength, form from drug/test names |
| `parseAmount()` | PrescriptionLinkage.gs | Parse "1500 INR" → 1500 |
| `matchMedicines()` | PrescriptionLinkage.gs | Match bill items vs prescribed medicines (≥70% fuzzy) |
| `matchTests()` | PrescriptionLinkage.gs | Match bill/report items vs prescribed tests (≥70% fuzzy) |
| `matchByDate()` | PrescriptionLinkage.gs | Match consultation bills by date proximity (±1 day) |
| `linkToPrescription()` | PrescriptionLinkage.gs | Core dispatch: category → correct matcher |
| `checkClaimCompleteness()` | PrescriptionLinkage.gs | 5-rule validator for insurance submission |
| `runPrescriptionLinkage()` | PrescriptionLinkage.gs | Pass 2 entry point for a claim folder |
| `updatePrescriptionCoverageReport()` | PrescriptionLinkage.gs | Generate 3-tab Consolidated Report |
| `getOrCreateSheet()` | PrescriptionLinkage.gs | Sheet tab helper |
