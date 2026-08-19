# Campaign name injection for Google Ads

**There's no `{campaignname}` in ValueTrack.** Google Ads will happily tell
your analytics *which* campaign sent a click — but only as a number.

This Google Ads Script closes that gap: it keeps every campaign's name in a
`{_campaign}` custom parameter and every ad group's name in `{_adgroup}`, so
any URL you build — a tracking template, a `utm_campaign`, a call-tracking
payload — carries human-readable names that maintain themselves, including
through renames.

**Works with all campaign types, including Performance Max**, and logs exactly
what it changed on every run.

```
# self-maintaining UTMs
{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={_campaign}&utm_content={_adgroup}

# Infinity call tracking
{lpurl}?infinity=ict2~net~gaw~cmp~{_campaign}~ag~{_adgroup}~...
```

## The problem

ValueTrack has `{campaignid}` and `{adgroupid}`, but no name equivalents. So
anyone who needs readable names at click time — GA4 with manual UTMs, call
tracking (Infinity and friends), CRM campaign fields, server-side tagging,
warehouse pipelines — ends up either hand-editing URLs per campaign or
maintaining an ID→name lookup table that rots the first time someone renames
a campaign.

The standard workaround is custom parameters plus a scheduled script that
keeps them synced. But the commonly shared version of that script (including
the one some tracking vendors distribute) has a **silent failure mode**: it
updates campaigns through **`AdsApp.bulkUploads()`** (a CSV bulk upload), and
**bulk uploads don't apply campaign edits to Performance Max campaigns**. The
script gets no per-row feedback, so PMax campaigns simply never receive their
`{_campaign}` parameter — your PMax traffic arrives at the tracker with no
campaign name, and nothing in the script logs tells you why.

The fix is that Google Ads Scripts now supports Performance Max directly:
`AdsApp.performanceMaxCampaigns()` exposes the same
`urls().setCustomParameters()` as every other campaign type. This script sets
parameters directly on each entity and skips bulk uploads entirely.

## What it does

Every run, for each **enabled** campaign (Search, Display, Performance Max,
Shopping, Video, Demand Gen) and each ad group in an enabled campaign
(standard + Shopping):

1. Reads the entity's existing custom parameters.
2. Compares the stored `{_campaign}` / `{_adgroup}` value against the
   entity's current URL-encoded name.
3. If it's missing, blank, or stale (the entity was **renamed**), writes the
   correct value — merging with any other custom parameters, never replacing
   them.

Guardrails and logging:

- Skips (with a logged warning) entities already at Google's cap of
  **8 custom parameters**, or whose encoded name exceeds the
  **200-character** value limit.
- Logs one line per change, a per-source summary, and a grand total:
  `TOTAL scanned=43 updated=2 unchanged=41 skipped=0 errors=0`.
- Throws if any entity errored, so a scheduled run shows as **Failed** and
  triggers Google's script-failure email instead of silently succeeding.

## Setup

1. In Google Ads: **Tools → Bulk actions → Scripts → +**, and paste in
   [`sync-custom-parameters.gs`](sync-custom-parameters.gs).
2. **Authorise** the script when prompted.
3. Click **Preview** first — preview saves nothing, and the log shows exactly
   what a live run would change.
4. Run it once live, then **schedule it hourly or daily**. New or renamed
   campaigns and ad groups are picked up on the next run.

Your tracking template (account, campaign, or wherever you set it) can then
reference `{_campaign}` and `{_adgroup}`.

## Performance Max and asset groups

PMax campaigns have **asset groups** instead of ad groups, so `{_adgroup}` is
empty on PMax traffic by default. Two things worth knowing:

- Google recently added **"Asset group URL options"** (campaign → Asset
  groups → Edit assets → Asset group URL options), which support their own
  tracking template, final URL suffix, and **custom parameters** — and custom
  parameters resolve *lowest level wins*.
- So if you add a custom parameter `adgroup = <ASSET_GROUP_NAME>` on each
  asset group, your existing campaign-level tracking template's `{_adgroup}`
  resolves per asset group — no template changes needed, and your tracker
  receives asset-group names in the same field ad-group names arrive in.

This currently has to be done by hand in the UI: Google Ads Scripts can't set
asset-group custom parameters yet (`AssetGroupUrls` only exposes final-URL and
path methods), and at the time of writing the field isn't even queryable in
the Google Ads API. When Scripts support lands, this script will pick it up as
another entity source. Until then: add the parameter as a step in your
asset-group creation checklist.

Alternatively, `{assetgroupid}` is now a valid ValueTrack parameter in PMax
tracking templates if numeric IDs are enough for your reporting.

## Using with Infinity call tracking

If you're an Infinity customer, this script is a drop-in replacement for the
custom-parameter sync script Infinity shares — same parameter keys
(`{_campaign}` / `{_adgroup}`), same encoding convention — with the
difference that it actually reaches Performance Max campaigns, updates
renamed entities, and tells you what it did. Your existing
`infinity=ict2~...cmp~{_campaign}~ag~{_adgroup}...` tracking template keeps
working unchanged; pair it with the asset-group trick above and PMax traffic
reports asset-group names in Infinity too.

## FAQ

**Why not just use the tracking template without custom parameters?**
ValueTrack has `{campaignid}` but no `{campaignname}` — the only way to get
human-readable names into URLs is custom parameters, which is why scripts like
this exist.

**Does it touch paused campaigns?** No — only entities in enabled campaigns,
matching the behaviour of the original scripts it replaces. Adjust the
`withCondition` filters if you want broader coverage.

**What about names with special characters?** Names are URL-encoded with
`encodeURIComponent`, with literal `+` preserved (the convention Infinity's
tracking expects). Change `encodeName()` if your platform wants different
encoding.

**Will it fight with parameters set by other tools?** No — it reads the
existing parameter set and merges, only ever writing its own two keys.

## Disclaimer

Not affiliated with or endorsed by Infinity Tracking Ltd. "Infinity" is
referenced only to describe compatibility. Use at your own risk; always run
Preview first.

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Performify](https://performify.co.uk) — paid media, engineered.
