//! Kanban recurrence engine (client-side, LOCAL-ONLY — plan ruling R-rec-4).
//!
//! The `recurrence` column on `checklist_items` never syncs: no outbox payload
//! ever carries it, and `set_recurrence_raw` never marks the row dirty (same
//! contract class as the voice audio columns). The engine mirrors upstream
//! `app/_utils/recurrence-utils.ts` @ 54a3e112 byte-verbatim for the five
//! preset RRULE strings and camelCase JSON keys, implements grid slot math
//! with RFC 5545 month/year clamps (R-rec-8), and rolls due completed
//! recurring items reset-in-place (upstream `refreshRecurringItem` shape)
//! through the EXISTING outbox op kinds: `check`, `status`, `set_date`,
//! `set_reminder`. Roll predicate narrowed per R-rec-6: `completed=1` AND
//! `nextDue <= now` (we deliberately do NOT mirror upstream's status arm).

use crate::db::{board, checklists, items, outbox};
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Datelike, SecondsFormat, TimeZone, Timelike, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// The five upstream presets (keys/labels from app/_utils/recurrence-utils.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Daily,
    Weekly,
    Biweekly,
    Monthly,
    Yearly,
}

impl Preset {
    pub fn from_key(key: &str) -> Option<Preset> {
        match key {
            "daily" => Some(Preset::Daily),
            "weekly" => Some(Preset::Weekly),
            "biweekly" => Some(Preset::Biweekly),
            "monthly" => Some(Preset::Monthly),
            "yearly" => Some(Preset::Yearly),
            _ => None,
        }
    }

    pub fn key(&self) -> &'static str {
        match self {
            Preset::Daily => "daily",
            Preset::Weekly => "weekly",
            Preset::Biweekly => "biweekly",
            Preset::Monthly => "monthly",
            Preset::Yearly => "yearly",
        }
    }

    /// Byte-verbatim upstream RRULE strings (Global Constraints).
    pub fn rrule(&self) -> &'static str {
        match self {
            Preset::Daily => "FREQ=DAILY;INTERVAL=1",
            Preset::Weekly => "FREQ=WEEKLY;INTERVAL=1",
            Preset::Biweekly => "FREQ=WEEKLY;INTERVAL=2",
            Preset::Monthly => "FREQ=MONTHLY;INTERVAL=1",
            Preset::Yearly => "FREQ=YEARLY;INTERVAL=1",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Preset::Daily => "Daily",
            Preset::Weekly => "Weekly",
            Preset::Biweekly => "Bi-weekly",
            Preset::Monthly => "Monthly",
            Preset::Yearly => "Yearly",
        }
    }
}

/// LOCAL-ONLY recurrence record mirroring the upstream localStorage shape:
/// camelCase keys; the three optional fields are OMITTED from the JSON when
/// unset (upstream parity — Task 1's serde fence pins the exact bytes).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub rrule: String,
    pub dtstart: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_due: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_completed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

pub fn parse(json: &str) -> Option<Recurrence> {
    serde_json::from_str(json).ok()
}

impl Recurrence {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// Simple substring scan for FREQ= and INTERVAL= (no regex dep; brief guidance).
/// INTERVAL defaults to 1 when absent (RFC 5545 default); unparseable or
/// non-positive INTERVAL is rejected by the caller.
fn parse_rrule_parts(rrule: &str) -> Option<(Freq, i64)> {
    let mut freq: Option<Freq> = None;
    let mut interval: i64 = 1;
    for part in rrule.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("FREQ=") {
            freq = match v.trim().to_ascii_uppercase().as_str() {
                "DAILY" => Some(Freq::Daily),
                "WEEKLY" => Some(Freq::Weekly),
                "MONTHLY" => Some(Freq::Monthly),
                "YEARLY" => Some(Freq::Yearly),
                _ => None,
            };
        } else if let Some(v) = part.strip_prefix("INTERVAL=") {
            interval = v.trim().parse::<i64>().ok()?;
        }
    }
    Some((freq?, interval))
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// RFC3339 UTC "+00:00" (whole seconds) — the format every stored slot string
/// carries (matches the upstream-stored strings and the fences).
fn fmt_rfc3339(t: &DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// Monthly slot k steps the ABSOLUTE month index; the day clamps to the month
/// length FROM THE ORIGINAL day (R-rec-8: Jan 31 -> Feb 28, Mar 31 — every
/// slot rebuilt from dtstart, so clamps never accumulate). Time-of-day from
/// dtstart is preserved on every slot.
fn month_slot(start: &DateTime<Utc>, total_months: i64) -> Option<DateTime<Utc>> {
    let y = i32::try_from(total_months.div_euclid(12)).ok()?;
    let m = total_months.rem_euclid(12) as u32 + 1; // 1..=12
    let day = start.day().min(days_in_month(y, m));
    Utc.with_ymd_and_hms(y, m, day, start.hour(), start.minute(), start.second()).single()
}

/// Yearly slot: same month/day, clamped for non-leap Februaries (Feb 29
/// dtstart -> Feb 28 in 2025, Feb 29 again in 2028).
fn year_slot(start: &DateTime<Utc>, y: i32) -> Option<DateTime<Utc>> {
    let m = start.month();
    let day = start.day().min(days_in_month(y, m));
    Utc.with_ymd_and_hms(y, m, day, start.hour(), start.minute(), start.second()).single()
}

fn day_slot(start: &DateTime<Utc>, days: i64) -> Option<DateTime<Utc>> {
    // bounded so Duration::days itself cannot overflow (chrono range rejects
    // the rest via checked_add_signed)
    const MAX_DAYS: i64 = 1_000_000_000; // ~2.7M years
    if days.checked_abs()? > MAX_DAYS {
        return None;
    }
    start.checked_add_signed(chrono::Duration::days(days))
}

/// First grid slot STRICTLY after `after` (RFC3339 UTC "+00:00"), or None on
/// parse failure, non-positive interval, or when the slot would pass `until`
/// (an until-equal slot still fits). dtstart IS the grid's first occurrence
/// (RFC 5545): when it already lies in the future it is the answer, otherwise
/// the search starts at k=1 (R-rec-7's "first slot strictly after now").
pub fn next_slot(rrule: &str, dtstart: &str, after: &DateTime<Utc>, until: Option<&str>) -> Option<String> {
    let start = DateTime::parse_from_rfc3339(dtstart).ok()?.with_timezone(&Utc);
    let (freq, interval) = parse_rrule_parts(rrule)?;
    if interval <= 0 {
        return None;
    }
    let until_dt: Option<DateTime<Utc>> = match until {
        Some(u) => Some(DateTime::parse_from_rfc3339(u).ok()?.with_timezone(&Utc)),
        None => None,
    };
    let nth = |k: i64| -> Option<DateTime<Utc>> {
        match freq {
            Freq::Daily => day_slot(&start, interval.checked_mul(k)?),
            Freq::Weekly => day_slot(&start, interval.checked_mul(k)?.checked_mul(7)?),
            Freq::Monthly => month_slot(
                &start,
                start.year() as i64 * 12 + start.month0() as i64 + interval.checked_mul(k)?,
            ),
            Freq::Yearly => {
                let y = i32::try_from(start.year() as i64 + interval.checked_mul(k)?).ok()?;
                year_slot(&start, y)
            }
        }
    };
    let finish = |slot: DateTime<Utc>| -> Option<String> {
        if let Some(u) = &until_dt {
            if slot > *u {
                return None;
            }
        }
        Some(fmt_rfc3339(&slot))
    };
    // estimate k generously from the elapsed span, then adjust +/- onto the
    // exact grid boundary (brief guidance: nth(k) > after && nth(k-1) <= after)
    let est: i64 = match freq {
        Freq::Daily => {
            let elapsed = after.signed_duration_since(start).num_days();
            elapsed.div_euclid(interval) + 3
        }
        Freq::Weekly => {
            let step = interval.checked_mul(7).unwrap_or(i64::MAX);
            let elapsed = after.signed_duration_since(start).num_days();
            elapsed.div_euclid(step) + 3
        }
        Freq::Monthly => {
            let elapsed = (after.year() - start.year()) as i64 * 12 + (after.month0() as i64 - start.month0() as i64);
            elapsed.div_euclid(interval) + 3
        }
        Freq::Yearly => {
            let elapsed = (after.year() - start.year()) as i64;
            elapsed.div_euclid(interval) + 3
        }
    };
    let mut k: i64 = est.max(1);
    // walk down while the previous grid point is still strictly after `after`
    while k > 1 {
        match nth(k - 1) {
            Some(prev) if prev > *after => k -= 1,
            _ => break,
        }
    }
    // the epoch itself (nth(0) == dtstart): when already in the future it IS
    // the first slot strictly after `after`
    if k == 1 {
        if let Some(epoch) = nth(0) {
            if epoch > *after {
                return finish(epoch);
            }
        }
    }
    // walk up while the candidate is not strictly after `after` (cap guards the
    // pathologically huge spans; interval >= 1 so the grid always advances)
    while k <= 1_000_000 {
        match nth(k) {
            Some(slot) if slot > *after => return finish(slot),
            Some(_) => k += 1,
            None => break, // grid left the representable range
        }
    }
    None
}

/// BFS over `parent_id` — the same walk shape as `set_completed_recursive`,
/// returning only the DESCENDANTS (no shared helper existed; brief guidance).
fn collect_descendants(conn: &Connection, local_id: &str) -> AppResult<Vec<String>> {
    let mut to_walk = vec![local_id.to_string()];
    let mut i = 0;
    while i < to_walk.len() {
        let id = to_walk[i].clone();
        let mut stmt = conn.prepare("SELECT local_id FROM checklist_items WHERE parent_id=?1")?;
        let kids = stmt
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        to_walk.extend(kids);
        i += 1;
    }
    Ok(to_walk.into_iter().skip(1).collect())
}

/// Reset-in-place sweep (plan architecture + R-rec-1/2/6/8): rolls EVERY
/// completed recurring item whose nextDue has arrived — completed=false,
/// status -> first column, target date -> the new slot's UTC day, reminder
/// shifted by the slot delta, nextDue -> next slot strictly after `now`,
/// lastCompleted -> now — and syncs each reset through the EXISTING outbox
/// op kinds (check / status / set_date / set_reminder; children get check +
/// status with their own local_id). Rows with a PENDING op of their own are
/// shielded (the queued op owns the row until it replays); rows whose next
/// slot passed `until` (or that fail to parse) stay untouched. Per-row
/// transaction (brief: acceptable); returns the count of rolled TOP-LEVEL
/// items (children ride along uncounted).
pub fn sweep(conn: &Connection, now: DateTime<Utc>) -> AppResult<usize> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT local_id FROM checklist_items WHERE recurrence IS NOT NULL AND completed=1 ORDER BY position",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut rolled = 0usize;
    for local_id in ids {
        // pending-op shield — same ground rule as reconcile's pending filter
        if matches!(outbox::has_pending_for(conn, "checklist_item", &local_id), Ok(true)) {
            continue;
        }
        let txn = conn.unchecked_transaction()?;
        let row = match items::get(&txn, &local_id)? {
            Some(r) => r,
            None => continue,
        };
        let rec = match row.recurrence.as_deref().and_then(parse) {
            Some(r) => r,
            None => continue,
        };
        // R-rec-6 narrow predicate: candidate filter gave completed=1; the roll
        // ALSO requires nextDue <= now (an unparseable nextDue counts as due-now,
        // which also feeds the R-rec-2 delta fallback below)
        let old_instant = rec
            .next_due
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or(now);
        if old_instant > now {
            continue; // not due yet: untouched (empty txn drops back)
        }
        let slot_str = match next_slot(&rec.rrule, &rec.dtstart, &now, rec.until.as_deref()) {
            Some(s) => s,
            None => continue, // series ended (until passed) or unparseable: stays completed
        };
        let new_instant = match DateTime::parse_from_rfc3339(&slot_str) {
            Ok(d) => d.with_timezone(&Utc),
            Err(_) => continue,
        };
        // reminder shift basis: newSlot - oldSlot (old unparseable -> old was
        // `now`, so the delta falls back to newSlot - now — R-rec-2)
        let delta = new_instant.signed_duration_since(old_instant);
        // first column = lowest sort_order in the cached board, else the render
        // default "todo" (board::list empty-cache fallback)
        let first_col = board::list(&txn, &row.checklist_id)?
            .first()
            .map(|s| s.status_id.clone())
            .unwrap_or_else(|| "todo".to_string());
        let status_changed = row.status.as_deref() != Some(first_col.as_str());
        let slot_ymd = new_instant.format("%Y-%m-%d").to_string();
        // LOCAL resets via the existing setters (each marks the row dirty; the
        // sync happens through the ops enqueued below, not through recurrence)
        items::set_checked(&txn, &local_id, false)?;
        items::set_status(&txn, &local_id, Some(first_col.clone()), false, status_changed)?;
        items::set_target_date(&txn, &local_id, Some(slot_ymd.clone()))?;
        let mut shifted_reminder: Option<String> = None;
        if let Some(old_rem) = row.reminder_datetime.as_deref() {
            let old_parsed = DateTime::parse_from_rfc3339(old_rem).ok().map(|d| d.with_timezone(&Utc));
            if let Some(shifted) = old_parsed.and_then(|o| o.checked_add_signed(delta)) {
                let new_rem = fmt_rfc3339(&shifted);
                items::set_reminder_local(&txn, &local_id, Some(new_rem.clone()))?;
                shifted_reminder = Some(new_rem);
            }
        }
        let rec_next = Recurrence {
            rrule: rec.rrule.clone(),
            dtstart: rec.dtstart.clone(),
            next_due: Some(slot_str),
            last_completed: Some(fmt_rfc3339(&now)),
            until: rec.until.clone(),
        };
        items::set_recurrence_raw(&txn, &local_id, Some(&rec_next.to_json()))?;
        outbox::enqueue(&txn, "check", "checklist_item", &local_id, &json!({
            "checklist_id": row.checklist_id, "item_local_id": local_id, "checked": false
        }))?;
        outbox::enqueue(&txn, "status", "checklist_item", &local_id, &json!({
            "checklist_id": row.checklist_id, "item_local_id": local_id, "status": first_col
        }))?;
        outbox::enqueue(&txn, "set_date", "checklist_item", &local_id, &json!({
            "checklist_id": row.checklist_id, "item_local_id": local_id, "targetDate": slot_ymd
        }))?;
        if let Some(new_rem) = &shifted_reminder {
            outbox::enqueue(&txn, "set_reminder", "checklist_item", &local_id, &json!({
                "checklist_id": row.checklist_id, "item_local_id": local_id, "datetime": new_rem
            }))?;
        }
        // children: un-complete + move to the first column, each with its own
        // check + status ops (child local_id in BOTH entity_id and payload)
        for child_id in collect_descendants(&txn, &local_id)? {
            let child = match items::get(&txn, &child_id)? {
                Some(c) => c,
                None => continue,
            };
            let child_changed = child.status.as_deref() != Some(first_col.as_str());
            items::set_checked(&txn, &child_id, false)?;
            items::set_status(&txn, &child_id, Some(first_col.clone()), false, child_changed)?;
            outbox::enqueue(&txn, "check", "checklist_item", &child_id, &json!({
                "checklist_id": child.checklist_id, "item_local_id": child_id, "checked": false
            }))?;
            outbox::enqueue(&txn, "status", "checklist_item", &child_id, &json!({
                "checklist_id": child.checklist_id, "item_local_id": child_id, "status": first_col
            }))?;
        }
        let top_level = row.parent_id.is_none();
        txn.commit()?;
        if top_level {
            rolled += 1;
        }
    }
    Ok(rolled)
}

/// Author/clear a kanban card's recurrence (R-rec-7): dtstart anchors to the
/// item's target date at UTC midnight when present (upstream
/// convertToUTCMidnight shape), else to now; nextDue is ALWAYS the first slot
/// strictly after now. With NO target date the card gets stamped with
/// nextDue's UTC day + one `set_date` op; with one, the date stays untouched.
/// Clearing (None) wipes the LOCAL-ONLY column raw — never dirty, never an op
/// (voice-audio contract class). Kanban-family gate BEFORE any write, exactly
/// mirroring set_item_reminder_inner.
pub(crate) fn set_item_recurrence_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    preset_key: Option<String>,
) -> AppResult<()> {
    let list_type = checklists::get_checklist(conn, checklist_id)?
        .map(|c| c.list_type)
        .unwrap_or_default();
    if list_type != "kanban" && list_type != "task" {
        return Err(AppError::Other("recurrence only works on kanban boards".into()));
    }
    let key = match preset_key {
        Some(k) => k,
        None => {
            items::set_recurrence_raw(conn, item_local_id, None)?;
            return Ok(());
        }
    };
    let preset = Preset::from_key(&key)
        .ok_or_else(|| AppError::Other("unknown recurrence preset".into()))?;
    let tx = conn.transaction()?;
    let row = items::get(&tx, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("item {item_local_id} not found")))?;
    let now = Utc::now();
    let (dtstart, has_target_date) = match row
        .target_date
        .as_deref()
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    {
        Some(d) => (format!("{d}T00:00:00+00:00"), true),
        None => (fmt_rfc3339(&now), false),
    };
    let slot = next_slot(preset.rrule(), &dtstart, &now, None)
        .ok_or_else(|| AppError::Other("no next recurrence slot".into()))?;
    if !has_target_date {
        let slot_ymd = match DateTime::parse_from_rfc3339(&slot) {
            Ok(d) => d.with_timezone(&Utc).format("%Y-%m-%d").to_string(),
            Err(_) => return Err(AppError::Other("unparseable next slot".into())),
        };
        items::set_target_date(&tx, item_local_id, Some(slot_ymd.clone()))?;
        outbox::enqueue(&tx, "set_date", "checklist_item", item_local_id, &json!({
            "checklist_id": checklist_id, "item_local_id": item_local_id, "targetDate": slot_ymd
        }))?;
    }
    let rec = Recurrence {
        rrule: preset.rrule().to_string(),
        dtstart,
        next_due: Some(slot),
        last_completed: None,
        until: None,
    };
    items::set_recurrence_raw(&tx, item_local_id, Some(&rec.to_json()))?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::{self, NewItem};
    use crate::db::migrations;
    use crate::db::outbox;
    use chrono::TimeZone;
    use serde_json::json;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn kanban_item(conn: &Connection, id: &str, text: &str) -> String {
        // INSERT OR IGNORE: tests seed TWO items into the SAME checklist id
        // (sweep_skips_not_due_and_non_completed) — the checklist row must be
        // created once and reused (disclosed adaptation of the brief's helper).
        conn.execute(
            "INSERT OR IGNORE INTO checklists (id, title, list_type, created_at, updated_at) VALUES (?1, 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [id],
        )
        .unwrap();
        items::insert_local(conn, &NewItem { checklist_id: id.to_string(), parent_local_id: None, text: text.to_string(), status: None, priority: None, target_date: None }).unwrap().local_id
    }

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap()
    }

    #[test]
    fn preset_rrule_strings_match_upstream() {
        assert_eq!(Preset::Daily.rrule(), "FREQ=DAILY;INTERVAL=1");
        assert_eq!(Preset::Weekly.rrule(), "FREQ=WEEKLY;INTERVAL=1");
        assert_eq!(Preset::Biweekly.rrule(), "FREQ=WEEKLY;INTERVAL=2");
        assert_eq!(Preset::Monthly.rrule(), "FREQ=MONTHLY;INTERVAL=1");
        assert_eq!(Preset::Yearly.rrule(), "FREQ=YEARLY;INTERVAL=1");
        assert!(Preset::from_key("biweekly").is_some());
        assert!(Preset::from_key("nope").is_none());
        assert_eq!(Preset::Biweekly.label(), "Bi-weekly");
    }

    #[test]
    fn recurrence_json_matches_upstream_keys() {
        let rec = Recurrence { rrule: "FREQ=WEEKLY;INTERVAL=1".into(), dtstart: "2025-01-27T00:00:00+00:00".into(), next_due: Some("2025-02-03T00:00:00+00:00".into()), last_completed: None, until: None };
        assert_eq!(rec.to_json(), r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2025-01-27T00:00:00+00:00","nextDue":"2025-02-03T00:00:00+00:00"}"#);
        let parsed = parse(r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2025-01-27T00:00:00Z","nextDue":"2025-02-03T00:00:00Z","lastCompleted":"2025-01-27T10:00:00Z"}"#).unwrap();
        assert_eq!(parsed.next_due.as_deref(), Some("2025-02-03T00:00:00Z"));
        assert_eq!(parsed.last_completed.as_deref(), Some("2025-01-27T10:00:00Z"));
        assert!(parse("not json").is_none());
    }

    #[test]
    fn next_slot_daily_preserves_time_of_day() {
        let dtstart = "2026-10-01T14:30:00+00:00";
        let after = utc(2026, 10, 2, 0, 0);
        assert_eq!(next_slot("FREQ=DAILY;INTERVAL=1", dtstart, &after, None).as_deref(), Some("2026-10-02T14:30:00+00:00"));
        let after2 = utc(2026, 10, 2, 14, 30); // strictly-after boundary
        assert_eq!(next_slot("FREQ=DAILY;INTERVAL=1", dtstart, &after2, None).as_deref(), Some("2026-10-03T14:30:00+00:00"));
    }

    #[test]
    fn next_slot_weekly_and_biweekly_keep_weekday() {
        let dtstart = "2026-10-02T00:00:00+00:00"; // a Friday
        let after = utc(2026, 10, 2, 12, 0);
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=1", dtstart, &after, None).as_deref(), Some("2026-10-09T00:00:00+00:00"));
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=2", dtstart, &after, None).as_deref(), Some("2026-10-16T00:00:00+00:00"));
    }

    #[test]
    fn next_slot_monthly_clamps_to_month_length_from_original_day() {
        let dtstart = "2026-01-31T08:00:00+00:00";
        let after_jan = utc(2026, 1, 31, 8, 0);
        assert_eq!(next_slot("FREQ=MONTHLY;INTERVAL=1", dtstart, &after_jan, None).as_deref(), Some("2026-02-28T08:00:00+00:00"));
        let after_feb = utc(2026, 2, 28, 8, 0);
        assert_eq!(next_slot("FREQ=MONTHLY;INTERVAL=1", dtstart, &after_feb, None).as_deref(), Some("2026-03-31T08:00:00+00:00"));
    }

    #[test]
    fn next_slot_yearly_clamps_feb29() {
        let dtstart = "2024-02-29T00:00:00+00:00";
        let after = utc(2024, 2, 29, 0, 0);
        assert_eq!(next_slot("FREQ=YEARLY;INTERVAL=1", dtstart, &after, None).as_deref(), Some("2025-02-28T00:00:00+00:00"));
        let after_2025 = utc(2025, 2, 28, 0, 0);
        // the clamped Feb-28 IS an occurrence (RFC grid semantics): next strictly-after 2025-02-28 is 2026-02-28
        assert_eq!(next_slot("FREQ=YEARLY;INTERVAL=1", dtstart, &after_2025, None).as_deref(), Some("2026-02-28T00:00:00+00:00"));
    }

    #[test]
    fn next_slot_respects_until() {
        let dtstart = "2026-10-02T00:00:00+00:00";
        let after = utc(2026, 10, 2, 12, 0);
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=1", dtstart, &after, Some("2026-10-05T00:00:00+00:00")).is_none(), true);
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=1", dtstart, &after, Some("2026-10-09T00:00:00+00:00")).as_deref(), Some("2026-10-09T00:00:00+00:00"));
        assert!(next_slot("garbage", dtstart, &after, None).is_none());
    }

    #[test]
    fn sweep_rolls_due_item_reset_in_place_and_enqueues_ops() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Trash");
        items::set_target_date(&conn, &local_id, Some("2026-10-01".to_string())).unwrap();
        items::set_checked(&conn, &local_id, true).unwrap();
        items::set_reminder_local(&conn, &local_id, Some("2026-10-01T09:00:00+00:00".to_string())).unwrap();
        conn.execute("UPDATE checklist_items SET status='completed', recurrence=?1 WHERE local_id=?2", [
            r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2026-09-24T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#,
            local_id.as_str(),
        ]).unwrap();
        conn.execute("INSERT INTO board_statuses (checklist_id, status_id, label, sort_order, auto_complete) VALUES ('l1','backlog','Backlog',0,0), ('l1','done','Done',2,1)", []).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 12, 0)).unwrap();
        assert_eq!(rolled, 1);
        let row = items::get(&conn, &local_id).unwrap().unwrap();
        assert!(!row.completed);
        assert_eq!(row.status.as_deref(), Some("backlog"));
        assert_eq!(row.target_date.as_deref(), Some("2026-10-08"));
        assert_eq!(row.reminder_datetime.as_deref(), Some("2026-10-08T09:00:00+00:00"));
        assert!(row.dirty);
        let rec = parse(row.recurrence.as_deref().unwrap()).unwrap();
        assert_eq!(rec.next_due.as_deref(), Some("2026-10-08T00:00:00+00:00"));
        assert_eq!(rec.last_completed.as_deref(), Some("2026-10-05T12:00:00+00:00"));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='pending'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
        let payloads: Vec<String> = {
            let mut stmt = conn.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        // kinds: check, status, set_date, set_reminder (insertion order)
        let kinds: Vec<String> = {
            let mut stmt = conn.prepare("SELECT op_type FROM outbox WHERE state='pending' ORDER BY seq").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(kinds, vec!["check".to_string(), "status".to_string(), "set_date".to_string(), "set_reminder".to_string()]);
        let ck: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
        assert_eq!(ck["checked"], false);
        assert_eq!(ck["item_local_id"], local_id.as_str());
        assert_eq!(ck["checklist_id"], "l1");
        let st: serde_json::Value = serde_json::from_str(&payloads[1]).unwrap();
        assert_eq!(st["status"], "backlog");
        let dt: serde_json::Value = serde_json::from_str(&payloads[2]).unwrap();
        assert_eq!(dt["targetDate"], "2026-10-08");
        let rm: serde_json::Value = serde_json::from_str(&payloads[3]).unwrap();
        assert_eq!(rm["datetime"], "2026-10-08T09:00:00+00:00");
    }

    #[test]
    fn sweep_skips_not_due_and_non_completed() {
        let conn = db();
        let a = kanban_item(&conn, "l1", "Future slot");
        items::set_checked(&conn, &a, true).unwrap();
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2027-01-01T00:00:00+00:00"}"#, a.as_str()]).unwrap();
        let b = kanban_item(&conn, "l1", "Open card");
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, b.as_str()]).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 0);
        assert!(items::get(&conn, &a).unwrap().unwrap().completed);
        assert!(!items::get(&conn, &b).unwrap().unwrap().completed);
    }

    #[test]
    fn sweep_skips_rows_with_pending_ops() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Syncing");
        items::set_checked(&conn, &local_id, true).unwrap();
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, local_id.as_str()]).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", &local_id, &json!({"checklist_id": "l1", "item_local_id": local_id, "checked": true})).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 0);
        assert!(items::get(&conn, &local_id).unwrap().unwrap().completed);
    }

    #[test]
    fn sweep_resets_children_with_their_own_ops() {
        let conn = db();
        let parent = kanban_item(&conn, "l1", "Dad");
        let child = items::insert_local(&conn, &NewItem { checklist_id: "l1".into(), parent_local_id: Some(parent.clone()), text: "Kid".into(), status: None, priority: None, target_date: None }).unwrap().local_id;
        items::set_checked(&conn, &parent, true).unwrap();
        items::set_checked(&conn, &child, true).unwrap();
        conn.execute("UPDATE checklist_items SET status='done', recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, parent.as_str()]).unwrap();
        conn.execute("UPDATE checklist_items SET status='done' WHERE local_id=?1", [child.as_str()]).unwrap();
        conn.execute("INSERT INTO board_statuses (checklist_id, status_id, label, sort_order, auto_complete) VALUES ('l1','todo','Todo',0,0)", []).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 1);
        assert!(!items::get(&conn, &child).unwrap().unwrap().completed);
        assert_eq!(items::get(&conn, &child).unwrap().unwrap().status.as_deref(), Some("todo"));
        let kinds: Vec<String> = {
            let mut stmt = conn.prepare("SELECT op_type FROM outbox WHERE state='pending' ORDER BY seq").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        // parent: check, status, set_date; child: check, status
        assert_eq!(kinds, vec!["check".to_string(), "status".to_string(), "set_date".to_string(), "check".to_string(), "status".to_string()]);
        let child_check: serde_json::Value = serde_json::from_str(&{
            let mut stmt = conn.prepare("SELECT payload FROM outbox WHERE op_type='check' ORDER BY seq").unwrap();
            let all = stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap();
            all[1].clone()
        }).unwrap();
        assert_eq!(child_check["item_local_id"], child.as_str());
    }

    #[test]
    fn sweep_shifts_reminder_by_slot_delta() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Appt");
        items::set_checked(&conn, &local_id, true).unwrap();
        items::set_reminder_local(&conn, &local_id, Some("2026-10-01T09:30:00+00:00".to_string())).unwrap();
        // biweekly: old slot Oct 1 -> new slot Oct 15 => +14 days
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=WEEKLY;INTERVAL=2","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, local_id.as_str()]).unwrap();
        sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(items::get(&conn, &local_id).unwrap().unwrap().reminder_datetime.as_deref(), Some("2026-10-15T09:30:00+00:00"));
    }

    #[test]
    fn sweep_until_passed_keeps_completed_and_enqueues_nothing() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Ended series");
        items::set_checked(&conn, &local_id, true).unwrap();
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-09-01T00:00:00+00:00","nextDue":"2026-09-02T00:00:00+00:00","until":"2026-09-15T00:00:00+00:00"}"#, local_id.as_str()]).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 0);
        assert!(items::get(&conn, &local_id).unwrap().unwrap().completed);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn set_item_recurrence_inner_anchors_dtstart_to_existing_target_date() {
        let mut conn = db();
        let local_id = kanban_item(&conn, "l1", "Dated");
        items::set_target_date(&conn, &local_id, Some("2026-10-02".to_string())).unwrap();
        conn.execute("UPDATE checklist_items SET dirty=0, target_date='2026-10-02' WHERE local_id=?1", [local_id.as_str()]).unwrap();
        set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("weekly".into())).unwrap();
        let row = items::get(&conn, &local_id).unwrap().unwrap();
        let rec = parse(row.recurrence.as_deref().unwrap()).unwrap();
        assert_eq!(rec.dtstart, "2026-10-02T00:00:00+00:00");
        // nextDue is strictly after "now" (test runs at real now): it must be a future Friday-since-Oct-2 grid slot; assert it parses and is after dtstart
        let nd = DateTime::parse_from_rfc3339(rec.next_due.as_deref().unwrap()).unwrap();
        assert!(nd > DateTime::parse_from_rfc3339("2026-10-02T00:00:00+00:00").unwrap());
        // dirty row (target_date setter marks dirty) + no set_date op because a targetDate existed
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM outbox WHERE op_type='set_date'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn set_item_recurrence_inner_without_target_date_stamps_first_due() {
        let mut conn = db();
        let local_id = kanban_item(&conn, "l1", "Undated");
        set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("biweekly".into())).unwrap();
        let row = items::get(&conn, &local_id).unwrap().unwrap();
        let rec = parse(row.recurrence.as_deref().unwrap()).unwrap();
        assert_eq!(rec.rrule, "FREQ=WEEKLY;INTERVAL=2");
        assert_eq!(row.target_date.as_deref(), rec.next_due.as_deref().map(|s| &s[..10]));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM outbox WHERE op_type='set_date'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn set_item_recurrence_inner_clears_with_none_and_gates_non_kanban() {
        let mut conn = db();
        let local_id = kanban_item(&conn, "l1", "X");
        set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("daily".into())).unwrap();
        set_item_recurrence_inner(&mut conn, "l1", &local_id, None).unwrap();
        assert!(items::get(&conn, &local_id).unwrap().unwrap().recurrence.is_none());
        conn.execute("INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l2', 'L', 'simple', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        let plain = items::insert_local(&conn, &NewItem { checklist_id: "l2".into(), parent_local_id: None, text: "P".into(), status: None, priority: None, target_date: None }).unwrap().local_id;
        let err = set_item_recurrence_inner(&mut conn, "l2", &plain, Some("daily".into())).unwrap_err();
        assert!(format!("{}", err).contains("recurrence only works on kanban boards"));
        assert!(Preset::from_key("weekly").is_some());
        let bad = set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("junk".into())).unwrap_err();
        assert!(format!("{}", bad).contains("unknown recurrence preset"));
    }
}