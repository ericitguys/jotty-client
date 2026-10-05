# Kanban recurrence — client-side engine (v0.26.0 target)

Date: 2026-10-05. Design approved via clarify 2026-10-05 (4 picks, all recommended except timing = user OOB answer "Mirror the web").

## Problem

Upstream recurrence is web-only. Authoring: AddItemWithRecurrenceModal on kanban boards (presets DAILY/WEEKLY/BIWEEKLY/MONTHLY/YEARLY, RFC 5545 RRULE); storage: item metadata line `recurrence:<json {rrule,dtstart,nextDue,...}>`; refresh: server action `checkAndRefreshRecurringItems` (web `getUserChecklists` path only). REST exposes NONE of it: re-grepped upstream tip 54a3e112 (2026-09-28) — zero `recurrence` in `app/api/` + zero in `howto/API.md` + no item-`metadata` passthrough in any REST route. The client is a pure API client ⇒ it can neither read nor write server-side recurrence.

DECISION (user 2026-10-05): implement recurrence in the CLIENT. No upstream issue/PR (explicitly declined). Engine is 100% client-side; works against stock jotty.

## Upstream semantics being mirrored (source: /tmp/jotty-upstream recurrence-utils.ts @ 54a3e112)

- Presets: `FREQ=DAILY;INTERVAL=1`, `FREQ=WEEKLY;INTERVAL=1`, `FREQ=WEEKLY;INTERVAL=2` (Bi-weekly), `FREQ=MONTHLY;INTERVAL=1`, `FREQ=YEARLY;INTERVAL=1`.
- `shouldRefreshRecurringItem`: completed (status not TODO/PAUSED, or completed flag) AND (no nextDue OR nextDue <= now) AND until not passed.
- `refreshRecurringItem` = RESET-IN-PLACE, not a new item: completed=false, status=TODO, children reset uncompleted, `recurrence.nextDue` = next slot after NOW, `recurrence.lastCompleted` = now. Upstream does NOT touch targetDate and does NOT re-attach reminders (known gap).
- Slot math: grid-based off dtstart (RRule.after(now, inclusive=false)).

## Locked shape (2026-10-05)

1. **Timing mirrors the web**: completing a recurring card leaves it completed. When the next cycle's slot arrives (`nextDue <= now`), the client resets it — card reappears not-done in the first column with the fresh date.
2. **Kanban boards only** (v1).
3. **The 5 presets only** (labels Daily / Weekly / Bi-weekly / Monthly / Yearly). No custom RRULE entry.
4. **Reminder re-attaches to the next occurrence** (deliberate upstream-gap fix): new reminder = old reminder + (newSlot − oldSlot) — preserves time-of-day via the actual slot delta. Only when a reminder exists.

## Behavior

### Storage (Rust)

- Migration v5: `checklist_items.recurrence TEXT NULL` — JSON `{rrule, dtstart, nextDue, lastCompleted?, until?}`.
- **LOCAL-ONLY**: the field never rides an outbox op, never reaches a DTO the server sees (`commands/mod.rs` LOCAL-ONLY metadata precedent). Pull/upsert/reconcile MUST preserve the column on dirty AND clean rows.
- Per-device engine (disclosed): recurrence data lives on the device that authored it. Other client devices see the lifecycle only via the synced item ops and do not roll. Re-authoring on two devices is safe — reset-in-place model means worst case is converging LWW writes, never duplicate items.

### Slot math (Rust, chrono — no new deps)

- Fixed-pattern equivalents of the RRULE grid anchored at dtstart: daily +N days; weekly/bi-weekly +7/+14 days, same weekday as dtstart; monthly same day-of-month with month-length clamp; yearly same date with Feb-29 clamp. `nextSlot(after=now)` = first grid slot strictly after now. Document clamps in code + tests. (Our engine is the only consumer of client-authored recurrence — no wire-compat constraint; rules are disclosed, not invented silently.)

### Authoring (frontend)

- Kanban card ⋯ menu gains "Repeat" beside the existing date/reminder entries: submenu with the 5 presets + None (clear).
- Setting a preset from an item with a targetDate anchors dtstart to that date (UTC midnight, upstream `convertToUTCMidnight` shape), else to now. `nextDue` = first slot after now; `targetDate` on the card is LEFT ALONE at authoring time (dates stay user-controlled until a roll; first roll stamps the next slot). If the item has no targetDate, authoring sets `target_date = nextDue` date-only — the card must show its first due date.
- Card pill row (T3 tier-B pill pattern): recurrence chip (repeat icon + preset label), joins the existing date/reminder pills; menu reflects current state; selecting None clears.
- Mirror-web consequence shown subtly: completed recurring card's chip tooltip reads "resets <date>" (title attr).

### Roll engine (Rust)

- Sweep (new fn, db layer): recurring rows where `recurrence IS NOT NULL AND completed=1 AND nextDue<=now AND NOT pending-shield AND NOT tombstone/conflict` → reset-in-place:
  - Local tx: `completed=0`, `status` = lowest-order column id from the `board_statuses` cache for that list (fallback `"todo"` when no cache — upstream derive-defaults id is literally "todo"), children reset (`completed=0`, status → same target), `target_date` = date(newSlot), `recurrence.nextDue` = newSlot(after=now), `recurrence.lastCompleted` = now, `reminder_datetime` = old + (newSlot − oldSlot) when reminder present.
  - Ops enqueued (existing op types ONLY, replay paths untouched): check-op(false) for the item + each child; status op → first column; date op (targetDate); reminder op (existing API-key-viable PUT route from v0.20.0 fix b3b5276). Ops ride normal index-resolution + conflict flow.
- Trigger points, in order after each sync run: push → pull → reconcile → **sweep**. Plus board open (`fetch_task_board`) and app startup.
- Pending-shield: rows with pending outbox ops skip the sweep (no fighting the outbox; the roll fires on the next sweep after their push lands and the row is clean).
- Idempotence: after a roll, `nextDue > now` ⇒ predicate false. One tx per row-set; crash-safe per sync invariant 1.

### Sync-safety (invariants touched)

- Recurrence never leaves the device (invariant 1 class: every local mutation = one tx; recurrence mutation enqueues only STANDARD ops).
- Sweep after reconcile (order matters: pulled completions roll on the same run).
- Pulled completions from OTHER surfaces (web UI, another device) roll on the authoring device's next sweep — grid slots converge late rolls.

## Out-list (v1 does NOT)

- Plain-checklist recurrence. Custom RRULE/interval input. Upstream issue/PR (declined). Any visibility into web-authored (server-side) recurrence — REST drops it, impossible. Companion integration/push (separate project). Recurrence history UI (`lastCompleted` stored, unused). Editing beyond set/clear/re-pick.

## Tests (TDD sketch)

- Rust: slot-math units (all 5 presets; month-end clamp: Jan 31 → Feb 28/29 → Mar 31; Feb-29 yearly clamp; DTSTART-anchored weekly weekday); sweep predicate fences (completed+due / not-due / non-recurring / pending-shield skip / tombstone skip); roll tx fences (reset + children + targetDate stamp + reminder delta shift math; status = lowest-order cache id; "todo" fallback); pull-RECURRING-preservation fence (server pull must not null the column, dirty + clean rows); sweep-runs-after-reconcile order fence.
- Frontend jsdom: menu renders 5 presets + None; set/clear/re-pick invoke the command with the payload; chip renders label and joins pill row (T3 pattern fences); tooltip text fence.
- Integration (env-gated real 1.28.0): author recurrence → complete card via REST-visible ops → run sweep → raw-reqwest readback asserts server item uncompleted, targetDate moved, reminder moved.

## Ship

Minor bump → **0.26.0**. Staged ship per standing order: APK → Linux bundles → Windows CI exe; per-stage ntfy + thread pings. Release notes disclose: client-side engine, per-device authoring, web-invisible, upstream gap fix (reminder shift).