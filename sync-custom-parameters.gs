/**
 * Sync campaign & ad group names into Google Ads custom parameters
 * ================================================================
 *
 * A Google Ads Script that keeps a {_campaign} custom parameter on each
 * enabled campaign and a {_adgroup} custom parameter on each ad group in an
 * enabled campaign, each holding the entity's own (URL-encoded) name. Your
 * tracking template can then pass readable names to any analytics or
 * call-tracking platform: Infinity, or anything else that reads them from the
 * landing page URL.
 *
 * Why this exists
 * ---------------
 * The version of this script that a call-tracking vendor gave its customers
 * updated campaigns through AdsApp.bulkUploads() (a CSV bulk upload). Bulk
 * uploads don't apply custom parameter edits to Performance Max campaigns,
 * and the upload reports nothing back to the script, so PMax campaigns never
 * received their {_campaign} parameter while the logs looked fine.
 *
 * This version sets custom parameters directly on each entity via
 * entity.urls().setCustomParameters(). Performance Max has its own selector
 * (AdsApp.performanceMaxCampaigns()) and supports this exactly as Search and
 * Display campaigns do.
 *
 * What it covers
 * --------------
 *  - Campaigns: Search, Display, Performance Max and Shopping.
 *  - Not covered: Demand Gen (Scripts has no Demand Gen selector) and Video
 *    (AdsApp.VideoCampaign has no urls() method; the script logs one line and
 *    skips that source).
 *  - Ad groups: standard (Search/Display) and Shopping.
 *  - Performance Max has asset groups instead of ad groups. Scripts'
 *    AssetGroupUrls object can't set custom parameters (it only exposes final
 *    URL and path methods). The Google Ads API added asset group URL options
 *    in v25.2 (23 September 2026), so AdsApp.mutate() may be able to set them,
 *    but this script doesn't try that: it's untested. Set the parameter by
 *    hand whenever you create or rename an asset group; see the README's
 *    "Performance Max and asset groups" section for the {_adgroup} override.
 *
 * Behaviour
 * ---------
 *  - Merges with existing custom parameters instead of replacing them
 *    (setCustomParameters replaces the whole set, so we read-modify-write).
 *  - Updates whenever the stored value differs from the current name, which
 *    covers missing parameters, blanked values and renamed entities.
 *  - Skips (with a logged warning) entities already carrying the maximum
 *    8 custom parameters, or whose encoded name exceeds the 200-byte value
 *    limit, rather than failing the run.
 *  - Logs one line per change, a summary per entity source, and a grand
 *    total. Throws at the end if any entity errored, so a scheduled run
 *    shows as Failed and triggers Google's script-failure email.
 *
 * Usage
 * -----
 *  1. Google Ads > Tools > Bulk actions > Scripts > new script; paste this in.
 *  2. Authorise the script when prompted.
 *  3. Click PREVIEW first. Preview saves nothing, but the log shows exactly
 *     what a live run would change.
 *  4. Run once live, then schedule it hourly or daily. New or renamed
 *     campaigns and ad groups are picked up on the next run.
 */

// The custom parameter keys to maintain. Reference them in tracking
// templates as {_campaign} and {_adgroup}.
const CAMPAIGN_PARAM_KEY = 'campaign';
const AD_GROUP_PARAM_KEY = 'adgroup';

// Google Ads Scripts limits: at most 8 custom parameters per entity, and
// parameter values are capped at 200 bytes. (Keys are capped at 16 bytes.)
const MAX_CUSTOM_PARAMS = 8;
const MAX_VALUE_LENGTH = 200; // encodeURIComponent output is ASCII, so chars == bytes

function main() {
  const account = AdsApp.currentAccount();
  const isPreview = AdsApp.getExecutionInfo().isPreview();
  console.log(`Account: ${account.getName()} (${account.getCustomerId()})`);
  console.log(`Mode: ${isPreview ? 'PREVIEW - no changes will be saved' : 'LIVE'}`);

  // Aggregated counters across every entity source, for the final summary.
  const totals = { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };

  // Each campaign type lives behind its own selector in Google Ads Scripts:
  // AdsApp.campaigns() only returns Search and Display campaigns. This list
  // is why the script works for Performance Max where bulk-upload versions
  // silently don't.
  const campaignSources = [
    ['Search/Display campaigns', () => AdsApp.campaigns()],
    ['Performance Max campaigns', () => AdsApp.performanceMaxCampaigns()],
    ['Shopping campaigns', () => AdsApp.shoppingCampaigns()],
    // AdsApp.VideoCampaign has no urls() method, so syncSource logs one line
    // and skips this source. It stays listed so the log says Video campaigns
    // weren't covered, and so they'd be picked up if Google adds urls().
    ['Video campaigns', () => AdsApp.videoCampaigns()],
  ];
  // Demand Gen campaigns have no AdsApp selector (Scripts reaches them only
  // through AdsApp.search() and AdsApp.mutate()), so they aren't covered.

  for (const [label, getSelector] of campaignSources) {
    syncSource(label, getSelector, CAMPAIGN_PARAM_KEY, totals);
  }

  // Ad groups get their own key so tracking templates can carry both names.
  // Video ad groups are omitted: they don't expose URL fields in Scripts.
  const adGroupSources = [
    ['Ad groups', () => AdsApp.adGroups()],
    ['Shopping ad groups', () => AdsApp.shoppingAdGroups()],
  ];
  for (const [label, getSelector] of adGroupSources) {
    syncSource(label, getSelector, AD_GROUP_PARAM_KEY, totals);
  }

  console.log('----------------------------------------');
  console.log(
    `TOTAL scanned=${totals.scanned} updated=${totals.updated} ` +
    `unchanged=${totals.unchanged} skipped=${totals.skipped} errors=${totals.errors}`
  );

  // Fail loudly: a non-zero error count marks a scheduled run as Failed,
  // which triggers Google's script-failure notification email.
  if (totals.errors > 0) {
    throw new Error(`${totals.errors} entities failed to update - see log above.`);
  }
}

/**
 * Iterates one entity source (a campaign type or an ad group type) and
 * ensures every entity carries {_<paramKey>} = <url-encoded entity name>,
 * preserving all of its other custom parameters.
 *
 * @param {string}   label       Human-readable source name, used in logs.
 * @param {Function} getSelector Returns a fresh AdsApp selector for the source.
 * @param {string}   paramKey    Custom parameter key to maintain ('campaign' / 'adgroup').
 * @param {Object}   totals      Aggregate counters, mutated in place.
 */
function syncSource(label, getSelector, paramKey, totals) {
  let iterator;
  try {
    // Only touch entities inside enabled campaigns. Both AWQL- and
    // GAQL-style conditions work in Scripts; the GAQL form below is
    // accepted by every selector used here.
    iterator = getSelector()
      .withCondition('campaign.status = ENABLED')
      .get();
  } catch (e) {
    // A selector can be missing or unsupported on some runtimes/accounts.
    // Log and move on rather than killing the whole run.
    console.warn(`[${label}] selector unavailable, skipping this source: ${e}`);
    return;
  }

  const s = { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };

  while (iterator.hasNext()) {
    const entity = iterator.next();

    // Guard: some entity types (Video campaigns, for one) have no urls()
    // method, so custom parameters can't be set on them from Scripts. Skip
    // the whole source with one log line instead of erroring per entity,
    // which would mark the run Failed.
    if (typeof entity.urls !== 'function') {
      console.warn(`[${label}] entities have no urls() method in Scripts, skipping this source`);
      return;
    }

    s.scanned++;
    let name = '(unknown)';
    try {
      name = entity.getName();
      const value = encodeName(name);

      // Guard: parameter values are capped at 200 bytes. A truncated
      // value would decode incorrectly, so skip and warn instead.
      if (value.length > MAX_VALUE_LENGTH) {
        console.warn(
          `[${label}] SKIP "${name}": encoded value is ${value.length} chars ` +
          `(limit ${MAX_VALUE_LENGTH})`
        );
        s.skipped++;
        continue;
      }

      // Read the entity's existing parameters so we can merge, not replace.
      const params = entity.urls().getCustomParameters() || {};

      // Already correct (same encoded name)? Nothing to do. Note this check
      // also catches renames: a stale value fails the comparison and falls
      // through to the update below.
      if (params[paramKey] === value) {
        s.unchanged++;
        continue;
      }

      // Guard: entities can hold at most 8 custom parameters. Only relevant
      // when we'd be ADDING a key; overwriting an existing one is always safe.
      if (!(paramKey in params) && Object.keys(params).length >= MAX_CUSTOM_PARAMS) {
        console.warn(
          `[${label}] SKIP "${name}": already has ${MAX_CUSTOM_PARAMS} custom ` +
          `parameters, no room for {_${paramKey}}`
        );
        s.skipped++;
        continue;
      }

      // setCustomParameters replaces the whole set, so write the merged map.
      params[paramKey] = value;
      entity.urls().setCustomParameters(params);
      console.log(`[${label}] set {_${paramKey}}=${value} on "${name}" (id ${entity.getId()})`);
      s.updated++;
    } catch (e) {
      // One bad entity shouldn't stop the sweep; count it and continue.
      console.error(`[${label}] ERROR on "${name}": ${e}`);
      s.errors++;
    }
  }

  console.log(
    `[${label}] scanned=${s.scanned} updated=${s.updated} ` +
    `unchanged=${s.unchanged} skipped=${s.skipped} errors=${s.errors}`
  );
  for (const key in s) {
    totals[key] += s[key];
  }
}

/**
 * URL-encode an entity name for use as a custom parameter value, keeping
 * literal '+' characters as '+' (the convention Infinity's tracking expects).
 */
function encodeName(name) {
  return encodeURIComponent(name).replaceAll('%2B', '+');
}
