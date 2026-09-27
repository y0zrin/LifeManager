//! オフラインのあいだの変更を送るときの、GitHub 側の変更とのまとめ方。
//! base = 変更する前の値（手元で変更したときに見ていた値）、local = 手元の変更、remote = 今の GitHub の値

/// 1 つの値（タイトル・状態・マイルストーン）のまとめ方
#[derive(Debug, PartialEq)]
pub enum Merge<T> {
    /// GitHub がもう同じ値なので、送らなくてよい
    Keep,
    /// GitHub 側は変わっていないので、手元の値を送る
    Send(T),
    /// どちらも別の値に変えた（どちらを残すか、使う人に決めてもらう）
    Conflict,
}

pub fn merge_value<T: PartialEq + Clone>(base: &T, local: &T, remote: &T) -> Merge<T> {
    if remote == local {
        Merge::Keep
    } else if remote == base {
        Merge::Send(local.clone())
    } else {
        Merge::Conflict
    }
}

/// ラベル・担当者（集まり）は、手元で足したもの・外したものだけを、GitHub の今の集まりに当てる。
/// どちらの変更も残る（ぶつからない）
pub fn merge_set(base: &[String], local: &[String], remote: &[String]) -> Vec<String> {
    let removed: Vec<&String> = base.iter().filter(|b| !local.contains(b)).collect();
    let mut merged: Vec<String> = remote.iter().filter(|r| !removed.contains(r)).cloned().collect();
    for added in local.iter().filter(|l| !base.contains(l)) {
        if !merged.contains(added) {
            merged.push(added.clone());
        }
    }
    merged
}

/// 集まりとして同じか（並び順は気にしない）
pub fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|x| b.contains(x))
}

fn checkbox_body(line: &str) -> Option<(&str, bool, &str)> {
    // 「- [ ] 本文」「- [x] 本文」の形か（先頭の空白・「*」も認める）
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let rest = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "))?;
    let (checked, text) = if let Some(t) = rest.strip_prefix("[ ]") {
        (false, t)
    } else if let Some(t) = rest.strip_prefix("[x]").or_else(|| rest.strip_prefix("[X]")) {
        (true, t)
    } else {
        return None;
    };
    Some((indent, checked, text))
}

/// 本文のまとめ方。GitHub 側が変わっていなければ手元の本文を使う。
/// どちらも変わっていても、手元の変更がチェックボックスの付け外しだけなら、GitHub 側の本文に同じ付け外しをする。
/// それ以外は None（ぶつかった）
pub fn merge_text(base: &str, local: &str, remote: &str) -> Option<String> {
    if remote == base {
        return Some(local.to_string());
    }
    if remote == local {
        return Some(remote.to_string());
    }
    let base_lines: Vec<&str> = base.split('\n').collect();
    let local_lines: Vec<&str> = local.split('\n').collect();
    if base_lines.len() != local_lines.len() {
        return None;
    }
    let mut toggles = Vec::new();
    for (b, l) in base_lines.iter().zip(local_lines.iter()) {
        if b == l {
            continue;
        }
        match (checkbox_body(b), checkbox_body(l)) {
            (Some((bi, bc, bt)), Some((li, lc, lt))) if bi == li && bt == lt && bc != lc => toggles.push((*b, *l)),
            _ => return None,
        }
    }
    let mut merged: Vec<String> = remote.split('\n').map(|s| s.to_string()).collect();
    for (from, to) in toggles {
        if let Some(i) = merged.iter().position(|r| r == from) {
            merged[i] = to.to_string();
        } else if !merged.iter().any(|r| r == to) {
            // 付け外しした行が GitHub 側で消えたり書き換わったりしている
            return None;
        }
    }
    Some(merged.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn values_are_sent_only_when_github_did_not_change_them() {
        assert_eq!(merge_value(&"open", &"closed", &"open"), Merge::Send("closed"));
        assert_eq!(merge_value(&"open", &"closed", &"closed"), Merge::Keep);
        assert_eq!(merge_value(&"A", &"B", &"C"), Merge::Conflict);
    }

    #[test]
    fn sets_keep_changes_from_both_sides() {
        // 手元: 状態:未整理 → 状態:進行中。GitHub: 優先:高 を足した
        let merged = merge_set(&v(&["状態:未整理", "分野:仕事"]), &v(&["状態:進行中", "分野:仕事"]), &v(&["状態:未整理", "分野:仕事", "優先:高"]));
        assert!(same_set(&merged, &v(&["分野:仕事", "優先:高", "状態:進行中"])));
    }

    #[test]
    fn checkbox_toggles_are_applied_to_the_newer_body() {
        let base = "- [ ] 牛乳\n- [ ] パン";
        let local = "- [x] 牛乳\n- [ ] パン";
        let remote = "買うもの\n- [ ] 牛乳\n- [ ] パン\n- [ ] 卵";
        assert_eq!(merge_text(base, local, remote).as_deref(), Some("買うもの\n- [x] 牛乳\n- [ ] パン\n- [ ] 卵"));
        // 手元で文字も書き換えていたら、ぶつかったとみなす
        assert_eq!(merge_text(base, "- [x] 牛乳（低脂肪）\n- [ ] パン", remote), None);
        // GitHub が変わっていなければ、手元の本文をそのまま使う
        assert_eq!(merge_text(base, local, base).as_deref(), Some(local));
    }
}
