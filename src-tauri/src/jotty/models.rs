use serde::{Deserialize, Serialize};

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
