// Pure-function tests - no database connection needed, run in milliseconds.
// These specifically guard against the addMonthsToIsoDate bug found by
// ultrareview: Date.UTC() rolls an out-of-range day forward into the next
// month (Jan 31 + 1 month -> Mar 3) instead of clamping to the target
// month's real last day the way SQL Server's DATEADD(MONTH, 1, ...) does
// (Jan 31 + 1 month -> Feb 28). Without the clamp, a license's write-time
// status could disagree with every read path's SQL-computed status by up
// to 3 days around month-end - this was live-wrong on 2026-08-31 before
// the fix (see commit 6407fe7).
const { addMonthsToIsoDate, computeStatus } = require('../../utils/licenseStatus');

describe('addMonthsToIsoDate', () => {
  // Expected values below were confirmed live against SQL Server's own
  // DATEADD(MONTH, 1, ...) for every one of these dates before being
  // hardcoded here - see the verification in commit 6407fe7's message.
  const cases = [
    ['2026-01-29', '2026-02-28'],
    ['2026-01-30', '2026-02-28'],
    ['2026-01-31', '2026-02-28'], // the exact shape of the original bug
    ['2026-03-31', '2026-04-30'],
    ['2026-08-31', '2026-09-30'], // the actual live-triggering date
    ['2026-12-31', '2027-01-31'], // crosses a year boundary
    ['2024-01-31', '2024-02-29'], // leap year
    ['2028-02-29', '2028-03-29'], // leap year, non-month-end target
    ['2026-08-15', '2026-09-15'], // ordinary mid-month day, unaffected
  ];

  test.each(cases)('%s + 1 month -> %s (matches SQL DATEADD)', (input, expected) => {
    expect(addMonthsToIsoDate(input, 1)).toBe(expected);
  });
});

describe('computeStatus', () => {
  test('Free and Perpetual are always active regardless of dates', () => {
    expect(computeStatus('Free', null, '2026-08-31')).toBe('active');
    expect(computeStatus('Perpetual', '2020-01-01', '2026-08-31')).toBe('active');
  });

  test('Annual Subscription with no date_expire is unknown', () => {
    expect(computeStatus('Annual Subscription', null, '2026-08-31')).toBe('unknown');
  });

  test('Annual Subscription past date_expire is expired', () => {
    expect(computeStatus('Annual Subscription', '2020-01-01', '2026-08-31')).toBe('expired');
  });

  test('Annual Subscription far in the future is active', () => {
    expect(computeStatus('Annual Subscription', '2099-01-01', '2026-08-31')).toBe('active');
  });

  test('Annual Subscription within one month is near expire', () => {
    // Regression case for the exact bug: with today = 2026-08-31, the
    // "near expire" boundary is 2026-09-30 (not 2026-10-01, the wrong
    // pre-fix answer).
    expect(computeStatus('Annual Subscription', '2026-09-30', '2026-08-31')).toBe('near expire');
    expect(computeStatus('Annual Subscription', '2026-10-01', '2026-08-31')).toBe('active');
  });

  test('an unrecognized license_type is unknown', () => {
    expect(computeStatus('Something Else', '2099-01-01', '2026-08-31')).toBe('unknown');
  });
});
