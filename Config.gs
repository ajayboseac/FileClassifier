var CONFIG = {
  // 1. Open your Google Drive.
  // 2. Open the folder you want to scan. Look at the URL: drive.google.com/drive/folders/YOUR_ID_HERE
  SOURCE_FOLDER_ID: "1_l_xTR7a7mWJugRWM6OQbIIyx9NPqjdI",
  
  // 3. Open the folder where you want files to go.
  DEST_FOLDER_ID:   "1jJyMKmJT5xaFKLjk2IEoRZzOotAVU03W",
  
  // 4. Get your API Key from: https://aistudio.google.com/app/apikey
  API_KEY:          "",
  
  // Model to use for classification.
  // "gemini-2.0-flash" — fast, free tier, good accuracy, supports vision (images/PDFs).
  // "gemini-2.5-flash" — newer model, also free tier, recommended if 2.0 is deprecated.
  MODEL_NAME:       "gemini-2.0-flash",
  
  // Duplicate Detection: Set to true to enable duplicate file detection.
  // When enabled, files are checked against a registry of previously processed files
  // before any LLM calls. Duplicates are moved to a _duplicates/ folder.
  ENABLE_DUPLICATE_DETECTION: true,
  
  // Prescription Linkage: Set to true to enable prescription-centric reimbursement.
  // When enabled, bills and reports are matched against prescriptions to determine
  // what is reimbursable. Generates an enhanced 3-tab Consolidated Report.
  ENABLE_PRESCRIPTION_LINKAGE: true
};
