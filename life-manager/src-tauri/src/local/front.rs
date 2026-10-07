//! 頭の項目（`---` で囲んだ YAML）と本文を読む・書く（tasks/N/task.md・comments/*.md。1.1 の詳細設計 2.1）。
//! 項目は決めた順で書き（差分が見やすい）、知らない項目（手で足したもの）は最後に残す
use serde_yaml::{Mapping, Value};

/// 頭の項目と本文に分ける。頭の項目がない・閉じていない・YAML として読めないときは Err（読む側が broken/ へ移す）
pub fn parse(text: &str) -> Result<(Mapping, String), String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").ok_or("no front matter (---)")?;
    let (head, body) = if let Some(body) = rest.strip_prefix("---\n") {
        ("", body)
    } else if rest == "---" {
        ("", "")
    } else if let Some(at) = rest.find("\n---\n") {
        (&rest[..at + 1], &rest[at + 5..])
    } else if rest.ends_with("\n---") {
        (&rest[..rest.len() - 3], "")
    } else {
        return Err("front matter is not closed (---)".to_string());
    };
    let fields = match serde_yaml::from_str::<Value>(head).map_err(|e| e.to_string())? {
        Value::Mapping(fields) => fields,
        Value::Null => Mapping::new(),
        _ => return Err("front matter is not a mapping".to_string()),
    };
    // 書くときに本文の最後に足した改行を外す
    let body = body.strip_suffix('\n').unwrap_or(body);
    return Ok((fields, body.to_string()));
}

/// 頭の項目と本文をつなげる。項目は order の順に書き、order にない項目は最後に、読んだときの順で書く。
/// 本文の最後には改行を 1 つ足す（parse が外す）
pub fn write(fields: &Mapping, order: &[&str], body: &str) -> String {
    let mut out = String::from("---\n");
    for key in order {
        if let Some(v) = fields.get(*key) {
            out.push_str(&entry(&Value::from(*key), v));
        }
    }
    for (k, v) in fields {
        if !k.as_str().is_some_and(|k| order.contains(&k)) {
            out.push_str(&entry(k, v));
        }
    }
    out.push_str("---\n");
    if !body.is_empty() {
        out.push_str(body);
        out.push('\n');
    }
    return out;
}

/// 1 つの項目を書く。なるべく 1 行（`labels: [種別:イシュー, 優先:高]`・空は `closed_at:`）にし、
/// 読み戻して同じにならない書き方は使わない（そのときは YAML の書き方にまかせる）
fn entry(key: &Value, value: &Value) -> String {
    if let Some(name) = key.as_str().filter(|k| is_simple_key(k)) {
        for text in one_line(value) {
            let line = if text.is_empty() { format!("{}:\n", name) } else { format!("{}: {}\n", name, text) };
            if reads_back(&line, key, value) {
                return line;
            }
        }
    }
    let mut one = Mapping::new();
    one.insert(key.clone(), value.clone());
    return serde_yaml::to_string(&one).unwrap_or_default();
}

fn is_simple_key(key: &str) -> bool {
    return key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
}

/// 1 行の書き方の候補（引用符なし → JSON の引用符つき の順）
fn one_line(value: &Value) -> Vec<String> {
    let quoted = |s: &str| serde_json::to_string(s).unwrap_or_default();
    return match value {
        Value::Null => vec![String::new()],
        Value::Bool(b) => vec![b.to_string()],
        Value::Number(n) => vec![n.to_string()],
        Value::String(s) => vec![s.clone(), quoted(s)],
        Value::Sequence(items) => {
            let mut plain = Vec::new();
            let mut safe = Vec::new();
            for item in items {
                match item {
                    Value::String(s) => {
                        plain.push(s.clone());
                        safe.push(quoted(s));
                    }
                    Value::Number(n) => {
                        plain.push(n.to_string());
                        safe.push(n.to_string());
                    }
                    Value::Bool(b) => {
                        plain.push(b.to_string());
                        safe.push(b.to_string());
                    }
                    _ => return Vec::new(),
                }
            }
            vec![format!("[{}]", plain.join(", ")), format!("[{}]", safe.join(", "))]
        }
        _ => Vec::new(),
    };
}

fn reads_back(line: &str, key: &Value, value: &Value) -> bool {
    return match serde_yaml::from_str::<Mapping>(line) {
        Ok(read) => read.len() == 1 && read.get(key) == Some(value),
        Err(_) => false,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORDER: &[&str] = &["number", "title", "state", "state_reason", "labels", "assignees", "milestone", "created_at", "closed_at"];

    // UT-03: 頭の項目と本文を読み、書き戻すと同じ文になる。項目は決めた順で書く。知らない項目は最後に残す
    #[test]
    fn round_trips_our_own_format() {
        let text = "---\nnumber: 12\ntitle: プレイヤーのジャンプを作る\nstate: open\nstate_reason:\nlabels: [種別:イシュー, 状態:進行中, 見積:4時間]\nassignees: [y0zrin]\nmilestone: 3\ncreated_at: 2026-10-02T10:15:00+09:00\nclosed_at:\nmemo: 手で足した項目\n---\nスペースキーでジャンプする。\n\n- [x] 上に跳ぶ\n\n<!-- gantt:2026-10-02/2026-10-04 -->\n";
        let (fields, body) = parse(text).unwrap();
        assert_eq!(fields.get("number"), Some(&Value::from(12)));
        assert_eq!(fields.get("state_reason"), Some(&Value::Null));
        assert_eq!(fields.get("labels").and_then(|v| v.as_sequence()).map(|s| s.len()), Some(3));
        assert_eq!(body, "スペースキーでジャンプする。\n\n- [x] 上に跳ぶ\n\n<!-- gantt:2026-10-02/2026-10-04 -->");
        assert_eq!(write(&fields, ORDER, &body), text);
    }

    #[test]
    fn writes_in_the_given_order_and_keeps_unknown_fields_last() {
        let mut fields = Mapping::new();
        fields.insert("自分の印".into(), "残す".into());
        fields.insert("title".into(), "題".into());
        fields.insert("number".into(), 1.into());
        fields.insert("extra".into(), Value::Sequence(vec![1.into(), 2.into()]));
        assert_eq!(write(&fields, ORDER, ""), "---\nnumber: 1\ntitle: 題\n自分の印: 残す\nextra: [1, 2]\n---\n");
    }

    #[test]
    fn quotes_values_that_would_read_back_differently() {
        let tricky = [
            "#12 を直す",
            "1: はじめる",
            "true",
            "123",
            "",
            "  前に空白",
            "null",
            "a: b",
            "[かっこ]",
            "二行\nある",
            "引用符 \" と \\",
            "- 箇条書き",
            "@人",
            "〜 波 〜",
        ];
        for title in tricky {
            let mut fields = Mapping::new();
            fields.insert("title".into(), title.into());
            fields.insert("labels".into(), Value::Sequence(vec![title.into(), "a, b".into(), "種別:メモ".into()]));
            let text = write(&fields, ORDER, "本文");
            let (read, body) = parse(&text).unwrap();
            assert_eq!(read, fields, "{}", text);
            assert_eq!(body, "本文");
        }
    }

    #[test]
    fn body_newlines_round_trip() {
        for body in ["", "一行", "最後に改行\n", "\n前に改行", "---\n本文の中の線"] {
            let mut fields = Mapping::new();
            fields.insert("number".into(), 1.into());
            let (_, read) = parse(&write(&fields, ORDER, body)).unwrap();
            assert_eq!(read, body);
        }
    }

    #[test]
    fn reads_crlf_bom_and_empty_front_matter() {
        let (fields, body) = parse("\u{feff}---\r\ntitle: 題\r\n---\r\n本文\r\n").unwrap();
        assert_eq!(fields.get("title"), Some(&Value::from("題")));
        assert_eq!(body, "本文");
        assert_eq!(parse("---\n---\n本文\n").unwrap(), (Mapping::new(), "本文".to_string()));
        assert_eq!(parse("---\ntitle: 題\n---").unwrap().1, "");
    }

    // UT-04: --- が閉じていない・YAML が壊れている → Err
    #[test]
    fn rejects_broken_front_matter() {
        assert!(parse("題だけ\n").is_err());
        assert!(parse("---\ntitle: 題\n本文\n").is_err());
        assert!(parse("---\ntitle: [閉じていない\n---\n本文\n").is_err());
        assert!(parse("---\n- 並び\n---\n").is_err());
    }
}
