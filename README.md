# Campaign name injection for Google Ads

**There's no `{campaignname}` in ValueTrack.** Google Ads will tell your
analytics *which* campaign sent a click, but only as a number.

This Google Ads Script closes that gap: it keeps each campaign's name in a
`{_campaign}` custom parameter and each ad group's name in `{_adgroup}`, so
your tracking URLs (a tracking template, a `utm_campaign`, a call-tracking
payload) carry current, readable names through launches and renames.

**Covers Search, Display, Shopping and Performance Max campaigns**, and logs
exactly what it changed on every run. Demand Gen and Video campaigns aren't
covered, and Performance Max asset group names are set by hand for now (see
below).

```
# self-maintaining UTMs
{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={_campaign}&utm_content={_adgroup}

# Infinity call tracking
{lpurl}?infinity=ict2~net~gaw~cmp~{_campaign}~ag~{_adgroup}~...
```

## The problem

ValueTrack has `{campaignid}` and `{adgroupid}`, but no name equivalents. So
anyone who needs readable names at click time (GA4 with manual UTMs, call
tracking such as Infinity, CRM campaign fields, server-side tagging,
warehouse pipelines) ends up either hand-editing URLs per campaign or keeping
a lookup table from ID to name by hand, which rots the first time someone
renames a campaign. An automated join from the Google Ads API keeps up with
renames, but only inside the warehouse: a call tracker or a form's hidden
field sees only the URL.

The standard workaround is custom parameters plus a scheduled script that
keeps them synced. But the version of that script a call-tracking vendor gave
its customers had a **silent failure mode** when I found it: it updated
campaigns through **`AdsApp.bulkUploads()`** (a CSV bulk upload), and **bulk
uploads don't apply custom parameter edits to Performance Max (PMax)
campaigns**. The upload reports nothing back to the script, so PMax campaigns
never received their `{_campaign}` parameter. PMax traffic arrived at the
tracker with no campaign name, and nothing in the script logs said why.

The fix is structural: Google Ads Scripts exposes Performance Max behind its
own selector, and `AdsApp.performanceMaxCampaigns()` supports
`urls().setCustomParameters()` exactly as Search and Display campaigns do.
This script sets parameters directly on each entity and skips bulk uploads
entirely.

## What it does

Every run, for each **enabled** campaign (Search, Display, Performance Max
and Shopping) and each ad group in an enabled campaign (standard and
Shopping):

1. Reads the entity's existing custom parameters.
2. Compares the stored `{_campaign}` / `{_adgroup}` value against the
   entity's current URL-encoded name.
3. If it's missing, blank, or stale (the entity was **renamed**), writes the
   correct value, merging with any other custom parameters rather than
   replacing them.

Guardrails and logging:

- Skips (with a logged warning) entities already at Google's cap of
  **8 custom parameters**, or whose encoded name exceeds the **200-byte**
  value limit in Scripts. (The script checks the URL-encoded value, which is
  ASCII, so its length in characters is its length in bytes.)
- Logs one line per change, a per-source summary, and a grand total:
  `TOTAL scanned=43 updated=2 unchanged=41 skipped=0 errors=0`.
- Throws if any entity errored, so a scheduled run shows as **Failed** and
  triggers Google's script-failure email instead of silently succeeding.

What it doesn't cover:

- **Demand Gen campaigns.** Scripts has no Demand Gen selector (it reaches
  them only through `AdsApp.search()` and `AdsApp.mutate()`).
- **Video campaigns.** `AdsApp.VideoCampaign` has no `urls()` method, so
  custom parameters can't be set on them from Scripts. The script logs one
  line for the Video source and skips it rather than failing the run.

## Setup

1. In Google Ads: **Tools → Bulk actions → Scripts → +**, and paste in
   [`sync-custom-parameters.gs`](sync-custom-parameters.gs).
2. **Authorise** the script when prompted.
3. Click **Preview** first. Preview saves nothing, and the log shows exactly
   what a live run would change.
4. Run it once live, then **schedule it hourly or daily**. New or renamed
   campaigns and ad groups are picked up on the next run.

Your tracking template (account, campaign, or wherever you set it) can then
reference `{_campaign}` and `{_adgroup}`.

## Performance Max and asset groups

PMax campaigns have **asset groups** instead of ad groups, so `{_adgroup}` is
empty on PMax traffic by default. Two things worth knowing:

- Asset groups have **"Asset group URL options"** (campaign → Asset groups →
  Edit assets → Asset group URL options): their own tracking template, final
  URL suffix and **custom parameters**. Custom parameters resolve *lowest
  level wins*.
- So if you add a custom parameter `adgroup = <ASSET_GROUP_NAME>` on each
  asset group, your existing tracking template's `{_adgroup}` resolves per
  asset group. No template changes are needed, and your tracker receives
  asset group names in the same field ad group names arrive in.

For now this is a manual step per asset group. Scripts' `AssetGroupUrls`
object can't set custom parameters (it only exposes final URL and path
methods). The Google Ads API added asset group URL options in v25.2
(23 September 2026), so the script should be able to set them through
`AdsApp.mutate()`, but that isn't tested and this script doesn't do it yet.
Until then, set the parameter by hand whenever you create or rename an asset
group.

Alternatively, `{assetgroupid}` is also a valid ValueTrack parameter in PMax
tracking templates if numeric IDs are enough for your reporting.

## Using with Infinity call tracking

If you're an Infinity customer, this script is a drop-in replacement for the
custom parameter sync script Infinity shared (same parameter keys,
`{_campaign}` / `{_adgroup}`, and the same encoding convention). The
difference is that it sets parameters on Performance Max campaigns directly
instead of through a bulk upload, updates renamed entities, and tells you
what it did. Your existing
`infinity=ict2~...cmp~{_campaign}~ag~{_adgroup}...` tracking template keeps
working unchanged; pair it with the asset-group trick above and PMax traffic
reports asset-group names in Infinity too.

## FAQ

**Why not just use the tracking template without custom parameters?**
ValueTrack has `{campaignid}` but no `{campaignname}`. Custom parameters are
the way to get readable names into URLs, which is why scripts like this
exist.

**Does it touch paused campaigns?** No, only entities in enabled campaigns,
matching the behaviour of the original scripts it replaces. Adjust the
`withCondition` filters if you want broader coverage.

**What about names with special characters?** Names are URL-encoded with
`encodeURIComponent`, with literal `+` preserved (the convention Infinity's
tracking expects). Change `encodeName()` if your platform wants different
encoding.

**Will it fight with parameters set by other tools?** No. It reads the
existing parameter set and merges, only ever writing its own two keys.

## Disclaimer

Not affiliated with or endorsed by Infinity Tracking Ltd. "Infinity" is
referenced only to describe compatibility. Use at your own risk; always run
Preview first.

## License

MIT. See [LICENSE](LICENSE).

---

Built by [Performify](https://performify.co.uk): paid media, engineered.
