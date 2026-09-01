// Pure date/status math for software licenses - no DB dependency at all, so
// it can be unit tested without opening a connection (config/sequelize.js
// eagerly authenticates on require, which is the right call for the running
// app but makes every model-file import expensive for a test that only
// needs this math). Used by models/softwareLicenseModel.js for its write-time
// status computation (createLicense/updateLicense) - the read-time
// equivalent lives in that file's own statusCaseSql(), expressed in SQL.

// SQL Server's DATEADD(MONTH, 1, ...) clamps to the target month's last real
// day (Jan 31 + 1 month -> Feb 28, not a rolled-forward Mar 3) - Date.UTC()
// does NOT do this on its own (an out-of-range day rolls into the next
// month instead), so the day-of-month has to be clamped explicitly first to
// match. Confirmed live against the DB: without this clamp, today=2026-08-31
// gave JS '2026-10-01' vs SQL's '2026-09-30' - see tests/utils/
// licenseStatus.test.js for the permanent regression coverage.
function addMonthsToIsoDate(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const targetIndex = (y * 12 + (m - 1)) + months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth0 = ((targetIndex % 12) + 12) % 12; // 0-based, always non-negative
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth0, Math.min(d, lastDayOfTargetMonth))).toISOString().slice(0, 10);
}

// The same status rule models/softwareLicenseModel.js's statusCaseSql()
// expresses in SQL for every read - this is the JS side, used only at
// write time (createLicense/updateLicense), so there is one rule per
// language rather than a third, separately-maintained copy. `today` must
// be a 'YYYY-MM-DD' string from the DB server's own clock (see
// softwareLicenseModel.js's getServerToday()), compared lexicographically
// exactly the way SQL Server's own DATE comparison would (ISO dates sort
// the same both ways).
function computeStatus(licenseType, dateExpire, today) {
  if (licenseType === 'Free' || licenseType === 'Perpetual') return 'active';
  if (licenseType === 'Annual Subscription') {
    if (!dateExpire) return 'unknown';
    if (dateExpire < today) return 'expired';
    if (dateExpire <= addMonthsToIsoDate(today, 1)) return 'near expire';
    return 'active';
  }
  return 'unknown';
}

module.exports = { addMonthsToIsoDate, computeStatus };
