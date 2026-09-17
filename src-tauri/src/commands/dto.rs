//! camelCase DTOs for the Tauri command layer (Task 14).
use crate::db::{checklists, items, notes};
use serde::Serialize;

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
        }
    }
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
            children: Vec::new(),
        }
    }
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
            items: Vec::new(),
        }
    }
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
}

