//! オフラインのあいだの変更を送るときの、GitHub 側の変更とのまとめ方。
//! base = 変更する前の値（手元で変更したときに見ていた値）、local = 手元の変更、remote = 今の GitHub の値
use serde::Serialize;

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

/// 改行を「\n」にそろえる（GitHub の画面で書いた本文は「\r\n」のことがある）
pub fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// 行ごとの 3 方向のまとめ（git の merge と同じ考え方）の 1 かたまり
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Hunk {
    /// そのまま使える行（どちらも変えていない・片方だけが変えた・両方が同じに変えた）
    Same { lines: Vec<String> },
    /// 両方が別々に変えたところ
    Conflict { base: Vec<String>, local: Vec<String>, remote: Vec<String> },
}

/// a の各行が、b のどの行と対応するか（いちばん長い共通の並びで対応させる）。表が大きすぎるときは None
fn line_matches(a: &[&str], b: &[&str]) -> Option<Vec<Option<usize>>> {
    let mut result = vec![None; a.len()];
    // 前と後ろの同じ行は先に対応させて、表を小さくする
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        result[start] = Some(start);
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
        result[end_a] = Some(end_b);
    }
    let (n, m) = (end_a - start, end_b - start);
    if n == 0 || m == 0 {
        return Some(result);
    }
    if n.saturating_mul(m) > 4_000_000 {
        return None;
    }
    // lengths[i][j] = a[start + i..end_a] と b[start + j..end_b] の、共通の並びの長さ
    let width = m + 1;
    let mut lengths = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lengths[i * width + j] = if a[start + i] == b[start + j] {
                lengths[(i + 1) * width + j + 1] + 1
            } else {
                lengths[(i + 1) * width + j].max(lengths[i * width + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[start + i] == b[start + j] {
            result[start + i] = Some(start + j);
            i += 1;
            j += 1;
        } else if lengths[(i + 1) * width + j] >= lengths[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    Some(result)
}

fn push_same(hunks: &mut Vec<Hunk>, lines: Vec<String>) {
    if lines.is_empty() {
        return;
    }
    if let Some(Hunk::Same { lines: last }) = hunks.last_mut() {
        last.extend(lines);
    } else {
        hunks.push(Hunk::Same { lines });
    }
}

fn push_conflict(hunks: &mut Vec<Hunk>, base: Vec<String>, local: Vec<String>, remote: Vec<String>) {
    // 続けてぶつかったところは 1 つにまとめて見せる
    if let Some(Hunk::Conflict { base: b, local: l, remote: r }) = hunks.last_mut() {
        b.extend(base);
        l.extend(local);
        r.extend(remote);
    } else {
        hunks.push(Hunk::Conflict { base, local, remote });
    }
}

/// 3 つの文章を行ごとにまとめる（別々のところを変えていれば両方の変更が残り、同じところを別々に変えていれば Conflict）。
/// 長すぎて比べられないときは None
pub fn merge_lines(base: &str, local: &str, remote: &str) -> Option<Vec<Hunk>> {
    let o: Vec<&str> = base.split('\n').collect();
    let a: Vec<&str> = local.split('\n').collect();
    let b: Vec<&str> = remote.split('\n').collect();
    let ma = line_matches(&o, &a)?;
    let mb = line_matches(&o, &b)?;
    let owned = |lines: &[&str]| lines.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let mut hunks = Vec::new();
    let (mut io, mut ia, mut ib) = (0, 0, 0);
    loop {
        // 3 つとも同じ行が続くところ
        let mut same = Vec::new();
        while io < o.len() && ma[io] == Some(ia) && mb[io] == Some(ib) {
            same.push(o[io].to_string());
            io += 1;
            ia += 1;
            ib += 1;
        }
        push_same(&mut hunks, same);
        if io >= o.len() && ia >= a.len() && ib >= b.len() {
            break;
        }
        // 次に 3 つとも同じになる行までが、どちらかが変えたところ
        let mut k = io;
        while k < o.len() && (ma[k].is_none() || mb[k].is_none()) {
            k += 1;
        }
        let (ea, eb) = match (ma.get(k).copied().flatten(), mb.get(k).copied().flatten()) {
            (Some(ea), Some(eb)) => (ea, eb),
            _ => (a.len(), b.len()),
        };
        let (co, ca, cb) = (&o[io..k], &a[ia..ea], &b[ib..eb]);
        if ca == co {
            push_same(&mut hunks, owned(cb));
        } else if cb == co || ca == cb {
            push_same(&mut hunks, owned(ca));
        } else if co.len() == ca.len() && co.len() == cb.len() {
            // 行の数が同じなら 1 行ずつ比べる（隣り合う別々の行を、それぞれが書き換えたとき）
            for i in 0..co.len() {
                if ca[i] == co[i] {
                    push_same(&mut hunks, owned(&cb[i..=i]));
                } else if cb[i] == co[i] || ca[i] == cb[i] {
                    push_same(&mut hunks, owned(&ca[i..=i]));
                } else {
                    push_conflict(&mut hunks, owned(&co[i..=i]), owned(&ca[i..=i]), owned(&cb[i..=i]));
                }
            }
        } else {
            push_conflict(&mut hunks, owned(co), owned(ca), owned(cb));
        }
        io = k;
        ia = ea;
        ib = eb;
    }
    Some(hunks)
}

/// ぶつかったところがなければ、まとめた文章
pub fn joined(hunks: &[Hunk]) -> Option<String> {
    let mut lines: Vec<&str> = Vec::new();
    for hunk in hunks {
        match hunk {
            Hunk::Same { lines: same } => lines.extend(same.iter().map(|s| s.as_str())),
            Hunk::Conflict { .. } => return None,
        }
    }
    Some(lines.join("\n"))
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

/// 手元の変更がチェックボックスの付け外しだけなら、GitHub 側の本文に同じ付け外しをする
fn apply_checkbox_toggles(base: &str, local: &str, remote: &str) -> Option<String> {
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

/// 本文のまとめ方。GitHub 側が変わっていなければ手元の本文を使う。
/// どちらも変わっていたら、行ごとにまとめる（別々のところの変更は両方残す）。
/// 同じところを変えていても、手元の変更がチェックボックスの付け外しだけなら、GitHub 側の本文に同じ付け外しをする。
/// それでもまとめられなければ None（ぶつかった）。改行は「\n」にそろえて返す
pub fn merge_text(base: &str, local: &str, remote: &str) -> Option<String> {
    let (base, local, remote) = (normalize_newlines(base), normalize_newlines(local), normalize_newlines(remote));
    if remote == base {
        return Some(local);
    }
    if remote == local {
        return Some(remote);
    }
    if let Some(merged) = merge_lines(&base, &local, &remote).as_deref().and_then(joined) {
        return Some(merged);
    }
    apply_checkbox_toggles(&base, &local, &remote)
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

    #[test]
    fn edits_in_different_places_are_both_kept() {
        let base = "目的\nやること\n- [ ] 下書き\n- [ ] 清書\nメモ";
        let local = "目的: 発表\nやること\n- [ ] 下書き\n- [ ] 清書\nメモ";
        let remote = "目的\nやること\n- [ ] 下書き\n- [ ] 清書\nメモ: 金曜まで";
        assert_eq!(
            merge_text(base, local, remote).as_deref(),
            Some("目的: 発表\nやること\n- [ ] 下書き\n- [ ] 清書\nメモ: 金曜まで")
        );
    }

    #[test]
    fn edits_to_the_same_line_are_shown_as_a_conflict() {
        let hunks = merge_lines("a\nb\nc", "a\nB1\nc", "a\nB2\nc").unwrap();
        assert_eq!(
            hunks,
            vec![
                Hunk::Same { lines: v(&["a"]) },
                Hunk::Conflict { base: v(&["b"]), local: v(&["B1"]), remote: v(&["B2"]) },
                Hunk::Same { lines: v(&["c"]) },
            ]
        );
        assert_eq!(merge_text("a\nb\nc", "a\nB1\nc", "a\nB2\nc"), None);
    }

    #[test]
    fn neighbouring_lines_edited_by_each_side_are_both_kept() {
        let base = "- 資料を読む\n- 要約を書く\n- 発表する";
        let local = "- 資料を読む（第3章まで）\n- 要約を書く\n- 発表する";
        let remote = "- 資料を読む\n- 要約を 400 字で書く\n- 発表する";
        assert_eq!(
            merge_text(base, local, remote).as_deref(),
            Some("- 資料を読む（第3章まで）\n- 要約を 400 字で書く\n- 発表する")
        );
    }

    #[test]
    fn line_endings_written_on_github_do_not_cause_conflicts() {
        // GitHub の画面で書いた本文は \r\n。アプリで直した本文は \n
        assert_eq!(merge_text("a\r\nb", "A\nb", "a\r\nb\r\nc").as_deref(), Some("A\nb\nc"));
    }
}
