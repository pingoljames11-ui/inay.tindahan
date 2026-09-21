/*
 * Tindahan Manager settings. This is the only file you normally need to edit.
 */
window.TINDAHAN_CONFIG = {

  // Your Stein API address (the Google Sheet that stores all store data).
  // Leave it as "" if you prefer NOT to publish the address in your GitHub repo:
  // the app will then ask for it once on each phone (see README, "Keeping the address private").
  STEIN_URL: "https://api.steinhq.com/v1/storages/6ab1024c92b1163e974651fe",

  // Optional: the normal Google Sheets link of the same spreadsheet.
  // If filled in, the owner sees an "Open Google Sheet" button under Account.
  SHEET_URL: "",

  // How often (seconds) an open phone checks for changes made on other phones.
  // Every check is one request to Google Sheets, so do not set this too low.
  REFRESH_SECONDS: 30,

  // How often (seconds) the history lists and users are re-read as well.
  FULL_REFRESH_SECONDS: 300,

  // How many days a phone stays signed in.
  SESSION_DAYS: 30
};
