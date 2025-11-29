# Deployment Guide: Google Apps Script

This guide explains how to "deploy" your code to Google's servers so it runs automatically.

## Prerequisites
- A Google Account (Gmail/Drive).
- The `Code.gs` and `Config.gs` files provided in this project.

## Step-by-Step Deployment

### 1. Create the Script
1.  Go to [script.google.com](https://script.google.com/home/start).
2.  Click **+ New Project**.
3.  Click on "Untitled project" (top header) and rename it to **"File Classifier"**.

### 2. Install the Code
1.  **Code.gs**:
    - You will see a file named `Code.gs` in the editor.
    - Delete any default code (like `function myFunction() {}`).
    - Copy the full content of `Code.gs` from this project and paste it there.
2.  **Config.gs**:
    - Click the **+** (plus icon) next to "Files" > **Script**.
    - Name it `Config`.
    - Copy the content of `Config.gs` and paste it there.

### 3. Configure
1.  Open `Config.gs` in the Google editor.
2.  Fill in your **SOURCE_FOLDER_ID**, **DEST_FOLDER_ID**, and **API_KEY**.
    - *Tip: Folder ID is the long string at the end of the URL when you open the folder in Drive.*

### 4. Enable Drive API (Crucial)
1.  Click **Services** (plus icon) on the left sidebar.
2.  Select **Drive API**.
3.  Click **Add**.

### 5. Test Run
1.  Open `Code.gs`.
2.  Select `processFiles` from the toolbar dropdown.
3.  Click **Run**.
4.  Grant permissions when prompted (Review Permissions -> Choose Account -> Advanced -> Go to File Classifier (unsafe) -> Allow).

### 6. "Deploy" (Automate)
To make it run 24/7 without you:
1.  Click **Triggers** (clock icon) on the left.
2.  Click **+ Add Trigger**.
3.  Settings:
    - Function: `processFiles`
    - Event source: `Time-driven`
    - Type: `Minutes timer`
    - Interval: `Every 15 minutes`
4.  Click **Save**.

**Success!** Your code is now deployed and running on Google's servers.
