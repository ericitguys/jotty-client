use serde::{Deserialize, Serialize};

/// PWA manifest served publicly at /api/manifest. Upstream regenerates
/// data/site.webmanifest from settings on every page render, so `name` and the
/// icon list always reflect the admin's current branding (v0.9.0).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct WebManifest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub short_name: Option<String>,
    /// The site's theme background color (e.g. "#111827") — upstream writes
    /// getThemeBackgroundColor(theme) here on every page render. The app maps
    /// it to a ported palette so the app follows the SITE's scheme even when
    /// the user never set a personal theme (0.10.7).
    #[serde(default)]
    pub theme_color: Option<String>,
    #[serde(default)]
    pub icons: Vec<ManifestIcon>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestIcon {
    pub src: String,
    #[serde(default)]
    pub sizes: String,
    #[serde(default)]
    #[serde(rename = "type")]
    pub mime: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerNote {
    pub id: String,
    pub title: String,
    pub category: String,
    pub content: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChecklist {
    pub id: String,
    pub title: String,
    pub category: String,
    #[serde(rename = "type")]
    pub list_type: Option<String>,
    #[serde(default)]
    pub items: Vec<ServerItem>,
    #[serde(default)]
    pub statuses: Option<Vec<serde_json::Value>>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub index: i64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub children: Vec<ServerItem>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
    #[serde(default)]
    pub estimated_time: Option<f64>,
}

impl ServerItem {
    pub fn simple(text: &str) -> ServerItem {
        ServerItem {
            text: text.to_string(),
            completed: Some(false),
            ..Default::default()
        }
    }
}

pub fn flatten_items(items: &[ServerItem]) -> Vec<(String, &ServerItem)> {
    let mut out = Vec::new();
    // NB: explicit 'a on items + the element type — elision + &mut invariance make the
    // one-verbatim-line version a hard rustc error (proven in Task 5, ruling in ledger).
    fn walk<'a>(prefix: &str, items: &'a [ServerItem], out: &mut Vec<(String, &'a ServerItem)>) {
        for (i, it) in items.iter().enumerate() {
            let path = if prefix.is_empty() { i.to_string() } else { format!("{prefix}.{i}") };
            out.push((path.clone(), it));
            walk(&path, &it.children, out);
        }
    }
    walk("", items, &mut out);
    out
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: String,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryNode {
    pub name: String,
    pub path: String,
    pub count: i64,
    pub level: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Categories {
    #[serde(default)]
    pub notes: Vec<CategoryNode>,
    #[serde(default)]
    pub checklists: Vec<CategoryNode>,
}

/// The subset of the upstream per-user preferences the desktop client acts
/// on. Source: GET /api/user → {user: {...}} (withApiAuth), fields per
/// upstream app/_types/user.ts. Everything optional: an older/newer server
/// must never break the parse.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserPrefs {
    #[serde(default)]
    pub preferred_theme: Option<String>,   // "system" | "light" | "dark" | <custom theme id>
    #[serde(default)]
    pub default_note_filter: Option<String>,       // "all" | "recent" | "pinned"
    #[serde(default)]
    pub default_checklist_filter: Option<String>,  // "all" | "completed" | "incomplete" | "pinned" | ...
    #[serde(default)]
    pub checklist_item_click_action: Option<String>, // "toggle" | "edit"
    #[serde(default)]
    pub hide_connection_indicator: Option<String>,   // "enable" | "disable"
    #[serde(default)]
    pub pinned_notes: Vec<String>,
    #[serde(default)]
    pub pinned_lists: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created<T> {
    #[serde(default)]
    pub success: bool,
    pub data: Option<T>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_note_list_payload_from_api_doc() {
        let raw = r#"{"notes":[{"id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","title":"My Note","category":"Personal","content":"Note content here...","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","owner":"fccview"}]}"#;
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let notes: Vec<ServerNote> = serde_json::from_value(v["notes"].clone()).unwrap();
        assert_eq!(notes[0].updated_at, "2024-01-01T00:00:00.000Z");
    }

    #[test]
    fn parses_checklist_with_nested_items_and_sparse_fields() {
        let raw = r#"{
          "id":"f47ac10b-58cc-4372-a567-0e02b2c3d479","title":"Project Tasks","category":"Work","type":"task",
          "items":[
            {"id":"list-123","index":0,"text":"Parent Task","completed":false,"status":"in_progress",
             "children":[{"id":"list-sub-456","index":0,"text":"Sub-task 1","completed":false},
                         {"id":"list-sub-789","index":1,"text":"Sub-task 2","completed":true}]},
            {"index":1,"text":"Bare item"}
          ],
          "createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}"#;
        let c: ServerChecklist = serde_json::from_str(raw).unwrap();
        assert_eq!(c.items.len(), 2);
        assert_eq!(c.items[0].children.len(), 2);
        assert!(c.items[1].id.is_none(), "sparse payload must parse");
    }

    #[test]
    fn flatten_paths_are_dot_notation_dfs() {
        let child1 = ServerItem { text: "s1".into(), ..ServerItem::simple("s1") };
        let child2 = ServerItem { text: "s2".into(), ..ServerItem::simple("s2") };
        let mut parent = ServerItem::simple("p");
        parent.children = vec![child1, child2];
        let third = ServerItem::simple("t");
        let input = [parent, third];
        let flat = flatten_items(&input);
        let paths: Vec<String> = flat.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(paths, vec!["0", "0.0", "0.1", "1"]);
    }

    #[test]
    fn parses_created_wrapper() {
        let raw = r#"{"success":true,"data":{"id":"note-123","title":"My New Note","content":"","category":"Personal","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","owner":"fccview"}}"#;
        let created: Created<ServerNote> = serde_json::from_str(raw).unwrap();
        assert_eq!(created.data.unwrap().id, "note-123");
    }
}
