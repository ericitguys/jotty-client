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
