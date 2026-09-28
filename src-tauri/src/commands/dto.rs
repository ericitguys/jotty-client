//! camelCase DTOs for the Tauri command layer (Task 14).
use crate::db::{checklists, items, notes};
use serde::Serialize;

/// Instance branding (v0.9.0): name + icon data-URL from /api/manifest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandingDto {
    pub name: Option<String>,
    pub icon_data_url: Option<String>,
    /// The site's theme background color (#rrggbb) — lets the frontend adopt
    /// the site's scheme even when the user has no personal theme preference.
    pub theme_color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
    pub audio_path: Option<String>,
    pub audio_duration_secs: Option<f64>,
}

impl From<notes::NoteRow> for NoteDto {
    fn from(r: notes::NoteRow) -> Self {
        NoteDto {
            id: r.id,
            title: r.title,
            content: r.content,
            category: r.category,
            created_at: r.created_at,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
            dirty: r.dirty,
            audio_path: r.audio_path,
            audio_duration_secs: r.audio_duration_secs,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTranscribeDto {
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    pub local_id: String,
    pub checklist_id: String,
    pub parent_local_id: Option<String>,
    pub text: String,
    pub completed: bool,
    pub position: i64,
    pub dirty: bool,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub server_item_id: Option<String>,
    pub reminder_datetime: Option<String>,
    pub reminder_notified: Option<bool>,
    pub children: Vec<ItemDto>,
}

impl From<items::ItemRow> for ItemDto {
    fn from(r: items::ItemRow) -> Self {
        ItemDto {
            local_id: r.local_id,
            checklist_id: r.checklist_id,
            parent_local_id: r.parent_id,
            text: r.text,
            completed: r.completed,
            position: r.position,
            dirty: r.dirty,
            status: r.status,
            priority: r.priority,
            target_date: r.target_date,
            start_date: r.start_date,
            server_item_id: r.server_item_id,
            reminder_datetime: r.reminder_datetime,
            reminder_notified: r.reminder_notified,
            children: Vec::new(),
        }
    }
}

/// One agenda row (appointments Task 4): a dated item joined with its list —
/// the flat cross-list feed AgendaView groups into Overdue/Today/Tomorrow/
/// Next 7d/Later. camelCase for the frontend (mirrors ItemDto's field casing).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaEntryDto {
    pub checklist_id: String,
    pub checklist_title: String,
    pub item_local_id: String,
    pub text: String,
    pub completed: bool,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub reminder_datetime: Option<String>,
    pub reminder_notified: Option<bool>,
    pub status: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistDto {
    pub id: String,
    pub title: String,
    pub category: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub list_type: String,
    #[serde(default)]
    pub items: Vec<ItemDto>,
}

impl From<checklists::ChecklistRow> for ChecklistDto {
    fn from(r: checklists::ChecklistRow) -> Self {
        ChecklistDto {
            id: r.id,
            title: r.title,
            category: r.category,
            created_at: r.created_at,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
            dirty: r.dirty,
            completed: false,
            list_type: r.list_type,
            items: Vec::new(),
        }
    }
}

/// Kanban column (Task 3): one board_statuses cache row or one server status,
/// serialized camelCase (`autoComplete`) for the frontend board renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardStatusDto {
    pub id: String,
    pub label: String,
    pub color: Option<String>,
    pub order: i64,
    pub auto_complete: bool,
}

impl From<crate::db::board::BoardStatusRow> for BoardStatusDto {
    fn from(r: crate::db::board::BoardStatusRow) -> Self {
        BoardStatusDto { id: r.status_id, label: r.label, color: r.color, order: r.sort_order, auto_complete: r.auto_complete }
    }
}

impl From<crate::jotty::models::ServerStatus> for BoardStatusDto {
    fn from(s: crate::jotty::models::ServerStatus) -> Self {
        BoardStatusDto { id: s.id, label: s.label, color: s.color, order: s.order, auto_complete: s.auto_complete }
    }
}

/// A board's columns: cache rows when cached, site defaults when not (spec §6).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDto {
    pub checklist_id: String,
    pub statuses: Vec<BoardStatusDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub instance_url: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryNodeDto {
    pub name: String,
    pub path: String,
    pub count: i64,
    pub level: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoriesDto {
    pub notes: Vec<CategoryNodeDto>,
    pub checklists: Vec<CategoryNodeDto>,
}

impl From<crate::jotty::models::Categories> for CategoriesDto {
    fn from(c: crate::jotty::models::Categories) -> Self {
        let map = |v: Vec<crate::jotty::models::CategoryNode>| {
            v.into_iter()
                .map(|n| CategoryNodeDto { name: n.name, path: n.path, count: n.count, level: n.level })
                .collect()
        };
        CategoriesDto { notes: map(c.notes), checklists: map(c.checklists) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteHit {
    pub id: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListHit {
    pub id: String,
    pub title: String,
    pub item_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultsDto {
    pub notes: Vec<NoteHit>,
    pub checklists: Vec<ListHit>,
}

// trigger_sync's report: the verbatim `sync::do_sync` (Task 13 transplant) returns ()
// and reports via the "sync-updated" event; the UI ignores this command's payload
// (plan line 3629: `invoke<unknown>('trigger_sync')`), so the DTO mirrors the
// post-sync outbox snapshot instead of fabricating push/pull stats.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReportDto {
    pub pending: i64,
    pub conflicts: i64,
    pub last_sync_at: Option<String>,
    // T3: per-board kanban reminder enrichment failures. The verbatim do_sync
    // reports the real count via the "sync-updated" event; this command-payload
    // mirror reports 0 (the outbox snapshot it reflects carries no pull stats).
    pub enrichment_errors: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub seq: i64,
    pub entity: String,
    pub entity_id: String,
    pub op_type: String,
    pub last_error: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub instance_url: Option<String>,
    pub sync_interval_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub pending: i64,
    pub last_sync_at: Option<String>,
    pub syncing: bool,
    // most recent outbox failure (pending or conflict rows), None when clean —
    // surfaced in the badge so "sync now does nothing" becomes "sync failed: <why>"
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRecordingDto {
    pub id: String,
    pub path: String,
    pub duration_secs: f64,
    pub raw_transcript: Option<String>,
    pub tidied_transcript: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
    pub created_at: String,
}

impl From<crate::db::voice::VoiceRecordingRow> for VoiceRecordingDto {
    fn from(r: crate::db::voice::VoiceRecordingRow) -> Self {
        VoiceRecordingDto {
            id: r.id,
            path: r.path,
            duration_secs: r.duration_secs,
            raw_transcript: r.raw_transcript,
            tidied_transcript: r.tidied_transcript,
            state: r.state,
            last_error: r.last_error,
            created_at: r.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyDto {
    pub tidied: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsDto {
    pub base_url: String,
    pub model: String,
    pub language_hint: String,
    pub api_path_suffix: String,
    pub has_key: bool,
}

/// One LLM-extracted appointment draft (voice → appointment, Task 8): nullable
/// fields — a null title means "no appointment in the transcript". Mirrors
/// voice_ai::AppointmentDraft; the TS contract lives in src/api/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppointmentDraftDto {
    pub title: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
}

impl From<crate::voice_ai::AppointmentDraft> for AppointmentDraftDto {
    fn from(d: crate::voice_ai::AppointmentDraft) -> Self {
        AppointmentDraftDto { title: d.title, date: d.date, time: d.time }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::ItemRow;

    #[test]
    fn item_dto_carries_appointment_fields() {
        let row = ItemRow {
            local_id: "l1".into(),
            checklist_id: "c1".into(),
            parent_id: None,
            text: "Dentist".into(),
            completed: false,
            position: 0,
            server_path: Some("0".into()),
            dirty: false,
            status: None,
            priority: None,
            target_date: Some("2026-10-01".into()),
            start_date: Some("2026-10-01".into()),
            server_item_id: Some("srv-1".into()),
            reminder_datetime: Some("2026-10-01T09:00:00.000Z".into()),
            reminder_notified: Some(true),
        };
        let dto = ItemDto::from(row);
        assert_eq!(dto.start_date.as_deref(), Some("2026-10-01"));
        assert_eq!(dto.server_item_id.as_deref(), Some("srv-1"));
        assert_eq!(dto.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"));
        assert_eq!(dto.reminder_notified, Some(true));
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["startDate"], "2026-10-01");
        assert_eq!(v["serverItemId"], "srv-1");
        assert_eq!(v["reminderDatetime"], "2026-10-01T09:00:00.000Z");
        assert_eq!(v["reminderNotified"], true);
    }
}

