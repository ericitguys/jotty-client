use crate::jotty::models::{flatten_items, ServerItem};

pub fn resolve(
    server_items: &[ServerItem],
    server_path: Option<&str>,
    text: &str,
    claimed: &mut Vec<String>,
) -> Option<String> {
    let flat = flatten_items(server_items);
    if let Some(p) = server_path {
        if let Some((_, it)) = flat.iter().find(|(path, _)| path == p) {
            if it.text == text && !claimed.iter().any(|c| c == p) {
                claimed.push(p.to_string());
                return Some(p.to_string());
            }
        }
    }
    for (path, it) in flat {
        if it.text == text && !claimed.iter().any(|c| c == &path) {
            claimed.push(path.clone());
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Vec<ServerItem> {
        let mut parent = ServerItem::simple("parent");
        parent.children = vec![ServerItem::simple("child-a"), ServerItem::simple("child-b")];
        vec![parent, ServerItem::simple("other")]
    }

    #[test]
    fn resolves_by_stored_path() {
        let t = tree();
        let mut claimed = vec![];
        assert_eq!(resolve(&t, Some("0.1"), "child-b", &mut claimed), Some("0.1".into()));
    }

    #[test]
    fn falls_back_to_text_and_claims() {
        let t = tree();
        let mut claimed = vec![];
        // stored path stale: item at "0.1" is "child-b" but local says "child-a" (renamed locally? no—text differs => fallback)
        assert_eq!(resolve(&t, Some("0.1"), "other", &mut claimed), Some("1".into()));
        // second identical request cannot claim the same server item
        assert_eq!(resolve(&t, Some("0.1"), "other", &mut claimed), None);
    }

    #[test]
    fn unresolvable_returns_none() {
        let t = tree();
        let mut claimed = vec![];
        assert_eq!(resolve(&t, None, "missing", &mut claimed), None);
    }
}
