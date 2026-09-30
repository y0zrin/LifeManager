// Issue（開いている・閉じた）の読み込みと操作。コメント・サブイシュー（親子）・テンプレート・変更の履歴・見積もりも
import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeWrite } from "../../lib/sending";
import { ESTIMATE_COLOR, UNITS, estimateLabel, withEstimate, type EstimateUnit } from "../../lib/estimate";
import type { CloseReason, GitHubComment, GitHubIssue, GitHubLabel, TimelineEvent } from "../../lib/types";
import { isSending, issueRef, nextSendingNumber } from "../../lib/issueRef";
import { adjustSummary, isSameRepo, issueApiUrl, parseIssueApiUrl } from "../../lib/subIssues";
import type { IssueTemplate } from "../../lib/issueTemplates";
import { isPending, PENDING_NOTE, type MakeEventNotice, type RepoScope } from "./shared";

/** Issue の操作に要る、ほかのフックのもの */
interface IssueDeps {
  /** リポジトリのラベル（状態を変えたときなど、ラベルの色をそろえる） */
  labels: GitHubLabel[];
  loadLabels: () => Promise<void>;
  /** ログインしている人（自分に割り当てる・メモの担当） */
  currentUser: string;
  /** 操作と一緒に送るお知らせ（イベント通知の設定による） */
  eventNotice: MakeEventNotice;
  /** 見積もりの単位（チームで一つ） */
  estimateUnit: EstimateUnit;
  /** 全部を読み直す（手元の写しにない Issue を変えたとき） */
  reloadAll: () => Promise<void>;
}

export function useIssues({ owner, repo, setStatus, friendlyError }: RepoScope, deps: IssueDeps) {
  const { labels, loadLabels, currentUser, eventNotice, estimateUnit, reloadAll } = deps;
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [closedIssues, setClosedIssues] = useState<GitHubIssue[]>([]);

  // --- ロード ---

  const loadIssues = useCallback(async () => {
    try {
      const result = await invoke("list_issues", { owner, repo, issueState: "open" });
      const fresh = JSON.parse(result as string) as GitHubIssue[];
      setIssues((prev) => [...prev.filter((i) => isSending(i.number)), ...fresh]);
    } catch (e) {
      setStatus(friendlyError(e));
    }
  }, [owner, repo]);

  const loadClosedIssues = useCallback(async () => {
    try {
      const result = await invoke("list_issues", { owner, repo, issueState: "closed" });
      setClosedIssues(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const reloadCached = useCallback(async () => {
    if (!owner || !repo) return;
    try {
      const [open, closed] = await Promise.all([
        invoke("list_issues", { owner, repo, issueState: "open", cached: true }),
        invoke("list_issues", { owner, repo, issueState: "closed", cached: true }),
      ]);
      const fresh = JSON.parse(open as string) as GitHubIssue[];
      setIssues((prev) => [...prev.filter((i) => isSending(i.number)), ...fresh]);
      setClosedIssues(JSON.parse(closed as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  /** プロジェクトを切り替える・ログアウトするとき、前の Issue を消す */
  function clear() {
    setIssues([]);
    setClosedIssues([]);
  }

  // --- Issue操作 ---

  /** Issue を閉じる。reason で閉じ方（完了・予定なし・重複）を選べる。重複なら、元の Issue も渡す */
  async function closeIssue(n: number, reason?: CloseReason, duplicateOf?: GitHubIssue) {
    try {
      const closedIssue = issues.find((i) => i.number === n);
      const issueTitle = closedIssue?.title || issueRef(n);
      if (reason === "duplicate" && !duplicateOf?.id) {
        throw new Error("元の Issue がまだ GitHub にないので、重複として閉じられません");
      }
      const how = reason === "not_planned" ? "を予定なしとして閉じました" : reason === "duplicate" ? `を ${issueRef(duplicateOf!.number)} の重複として閉じました` : "を完了";
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: "closed", labels: null, milestone: null, assignees: null,
        stateReason: reason ?? null,
        duplicateIssueId: reason === "duplicate" ? duplicateOf!.id : null,
        notice: eventNotice("issue_closed", `✅ {issue} ${issueTitle} ${how}`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} ${how === "を完了" ? "完了" : how.slice(1)}${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: openから除去し、closedに追加（副作用をupdater外に分離）
      setIssues((prev) => prev.filter((i) => i.number !== n));
      if (closedIssue) {
        setClosedIssues((prev) => [{ ...closedIssue, state: "closed", state_reason: reason ?? "completed", closed_at: new Date().toISOString() }, ...prev]);
      }
      adjustParentOf(closedIssue, 1);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function reopenIssue(n: number) {
    try {
      const reopenedIssue = closedIssues.find((i) => i.number === n);
      const issueTitle = reopenedIssue?.title || issueRef(n);
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: "open", labels: null, milestone: null, assignees: null,
        notice: eventNotice("issue_reopened", `🔄 {issue} ${issueTitle} を再開`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} 再開${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: closedから除去し、openに追加（副作用をupdater外に分離）
      setClosedIssues((prev) => prev.filter((i) => i.number !== n));
      if (reopenedIssue) {
        setIssues((prev) => [{ ...reopenedIssue, state: "open", closed_at: null }, ...prev]);
      }
      adjustParentOf(reopenedIssue, -1);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function promoteIssue(n: number) {
    try {
      const issue = issues.find((i) => i.number === n);
      if (!issue) return;
      const newLabels = issue.labels
        .map((l) => l.name)
        .filter((name) => name !== "種別:メモ")
        .concat(["種別:イシュー"]);
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: newLabels, milestone: null, assignees: null,
        notice: eventNotice("issue_promoted", `⬆ {issue} ${issue.title} をイシューに昇華`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} をイシューに昇華${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: ラベルをローカルで更新
      const updatedLabelObjs = issue.labels
        .filter((l) => l.name !== "種別:メモ")
        .concat([labels.find((l) => l.name === "種別:イシュー") || { name: "種別:イシュー", color: "0E8A16" }]);
      setIssues((prev) =>
        prev.map((i) => i.number === n ? { ...i, labels: updatedLabelObjs } : i)
      );
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function assignToMe(n: number) {
    if (!currentUser) return;
    try {
      const issue = issues.find((i) => i.number === n);
      if (!issue) return;
      const currentAssignees = issue.assignees?.map((a) => a.login) || [];
      if (currentAssignees.includes(currentUser)) {
        return; // 既に担当者
      }
      const newAssignees = [...currentAssignees, currentUser];
      // 楽観的更新
      setIssues((prev) =>
        prev.map((i) =>
          i.number === n
            ? { ...i, assignees: [...(i.assignees || []), { login: currentUser, avatar_url: `https://github.com/${encodeURIComponent(currentUser)}.png?size=40` }] }
            : i
        )
      );
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: null, milestone: null, assignees: newAssignees,
      });
      setStatus(`${issueRef(n)} → 自分に担当割り当て${isPending(result) ? PENDING_NOTE : ""}`);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function changeIssueStatus(n: number, newStatusLabel: string) {
    try {
      const issue = issues.find((i) => i.number === n);
      if (!issue) return;
      const newLabelNames = issue.labels
        .map((l) => l.name)
        .filter((name) => !name.startsWith("状態:"));
      if (newStatusLabel) {
        newLabelNames.push(newStatusLabel);
      }
      // 楽観的更新: 先にローカルを更新してから API を呼ぶ
      const newLabelObjs = issue.labels.filter((l) => !l.name.startsWith("状態:"));
      if (newStatusLabel) {
        const statusLabelObj = labels.find((l) => l.name === newStatusLabel);
        newLabelObjs.push(statusLabelObj || { name: newStatusLabel, color: "cccccc" });
      }
      setIssues((prev) =>
        prev.map((i) => i.number === n ? { ...i, labels: newLabelObjs } : i)
      );
      const statusName = newStatusLabel ? newStatusLabel.split(":")[1] : "未分類";
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: newLabelNames, milestone: null, assignees: null,
        notice: eventNotice("status_changed", `🔀 {issue} ${issue.title} → ${statusName}`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} → ${newStatusLabel}${pending ? PENDING_NOTE : ""}`);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  // --- Issue を作る: すぐ一覧に「送っています…」の仮の Issue を出し、GitHub から返事が来たら置き換える ---

  /** 送っているあいだの仮の Issue の、送り直しに要るもの（送れなかったときの「もう一度」） */
  type Send = { title: string; body: string; labels: string[]; milestone: number | null; assignees: string[] | null; message: string; done: string };
  const sends = useRef(new Map<number, Send>());
  // 今のリポジトリ（送っているあいだにプロジェクトを切り替えたら、返事を今の一覧に入れない）
  const repoNow = useRef("");
  repoNow.current = `${owner}/${repo}`;

  /** 仮の Issue（ラベルの色・マイルストーンは、今わかっているもので） */
  function placeholder(n: number, send: Send): GitHubIssue {
    const now = new Date().toISOString();
    return {
      number: n,
      title: send.title,
      body: send.body,
      state: "open",
      labels: send.labels.map((name) => ({ name, color: labels.find((l) => l.name === name)?.color ?? "ededed" })),
      milestone: null,
      assignees: (send.assignees ?? []).map((login) => ({ login, avatar_url: "" })),
      comments: 0,
      created_at: now,
      updated_at: now,
      _sending: true,
    } as GitHubIssue;
  }

  /** 送る（はじめてと、もう一度）。返事が来たら仮の Issue を置き換える。送れなければ「送れませんでした」にして、わけを返す */
  async function send(temp: number, one: Send): Promise<number> {
    const sentFrom = `${owner}/${repo}`;
    try {
      const result = await invokeWrite("create_issue", {
        owner, repo,
        title: one.title, body: one.body,
        labels: one.labels,
        milestone: one.milestone,
        assignees: one.assignees,
        notice: eventNotice("issue_created", one.message),
      });
      const pending = isPending(result);
      setStatus(`${one.done}${pending ? PENDING_NOTE : ""}`);
      sends.current.delete(temp);
      if (repoNow.current !== sentFrom) return 0; // もう別のプロジェクトを見ている（一覧は作り直された）
      // 返事の Issue に置き換える（送信待ちなら仮の番号）
      try {
        const newIssue = JSON.parse(result as string) as GitHubIssue;
        setIssues((prev) => [newIssue, ...prev.filter((i) => i.number !== temp && i.number !== newIssue.number)]);
        return newIssue.number;
      } catch {
        setIssues((prev) => prev.filter((i) => i.number !== temp));
        await loadIssues();
        return 0;
      }
    } catch (e) {
      const why = friendlyError(e);
      if (repoNow.current !== sentFrom) sends.current.delete(temp); // 仮の Issue は、切り替えたときに一覧ごと消えている
      setIssues((prev) => prev.map((i) => (i.number === temp ? { ...i, _sending: false, _failed: why } : i)));
      setStatus("送れませんでした: " + why);
      throw e;
    }
  }

  /** 仮の Issue を一覧のいちばん上に出してから、送る */
  async function start(one: Send): Promise<number> {
    const temp = nextSendingNumber();
    sends.current.set(temp, one);
    setIssues((prev) => [placeholder(temp, one), ...prev]);
    return send(temp, one);
  }

  async function createIssue(title: string, body: string, labelList: string[], milestone: number | null, assignees?: string[]): Promise<number> {
    return start({ title, body, labels: labelList, milestone, assignees: assignees ?? null, message: `📝 {issue} ${title} を作成`, done: "Issueを作成しました" });
  }

  async function createMemo(text: string, theme: string) {
    await start({
      title: text,
      body: "",
      labels: ["種別:メモ", "状態:未整理", theme].filter(Boolean),
      milestone: null,
      assignees: currentUser ? [currentUser] : null,
      message: `📝 {issue} ${text} をメモ投入`,
      done: "メモを投入しました",
    });
  }

  /** 送れなかった仮の Issue を、もう一度送る */
  async function retrySending(temp: number) {
    const one = sends.current.get(temp);
    if (!one) return;
    setIssues((prev) => prev.map((i) => (i.number === temp ? { ...i, _sending: true, _failed: undefined } : i)));
    await send(temp, one).catch(() => {});
  }

  /** 送れなかった仮の Issue を、やめる（一覧から消す） */
  function discardSending(temp: number) {
    sends.current.delete(temp);
    setIssues((prev) => prev.filter((i) => i.number !== temp));
  }

  // --- タスクトグル用の本文更新（ローカル即時反映） ---

  async function updateIssueBody(issueNumber: number, newBody: string) {
    try {
      // Todo進捗のお知らせ
      const todoDone = (newBody.match(/- \[x\]/g) || []).length;
      const todoTotal = (newBody.match(/- \[[ x]\]/g) || []).length;
      const issueTitle = [...issues, ...closedIssues].find((i) => i.number === issueNumber)?.title || issueRef(issueNumber);
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber,
        title: null, body: newBody, issueState: null, labels: null, milestone: null, assignees: null,
        notice: todoTotal > 0 ? eventNotice("todo_toggled", `☑ {issue} ${issueTitle} ${todoDone}/${todoTotal}完了`) : null,
      });
      const pending = isPending(result);
      if (pending) setStatus(`${issueRef(issueNumber)} の本文を変更しました${PENDING_NOTE}`);
      // ローカルのissue一覧も即座に更新して再レンダリングに反映
      setIssues((prev) =>
        prev.map((i) => i.number === issueNumber ? { ...i, body: newBody } : i)
      );
      setClosedIssues((prev) =>
        prev.map((i) => i.number === issueNumber ? { ...i, body: newBody } : i)
      );
    } catch (e) {
      setStatus("タスク更新エラー: " + e);
      throw e;
    }
  }

  // --- Issue編集 ---

  async function updateIssue(
    n: number,
    updates: { title?: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null }
  ) {
    try {
      const current = [...issues, ...closedIssues].find((i) => i.number === n);
      const title = updates.title ?? current?.title ?? issueRef(n);
      const result = await invokeWrite("update_issue", {
        owner, repo, issueNumber: n,
        title: updates.title ?? null,
        body: updates.body ?? null,
        issueState: null,
        labels: updates.labels ?? null,
        milestone: updates.milestone !== undefined ? (updates.milestone ?? 0) : null,
        assignees: updates.assignees ?? null,
        notice: eventNotice("issue_updated", `✏ {issue} ${title} を更新`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} を更新しました${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: APIレスポンスでローカルを即反映
      try {
        const updated = JSON.parse(result as string) as GitHubIssue;
        // 手元の写しにない Issue を送信待ちにしたときは、中身のない結果が返るので読み直す
        if (typeof updated.title !== "string") throw new Error("Issue の内容がありません");
        setIssues((prev) =>
          prev.map((i) => i.number === n ? updated : i)
        );
        setClosedIssues((prev) =>
          prev.map((i) => i.number === n ? updated : i)
        );
      } catch {
        await reloadAll();
      }
    } catch (e) {
      setStatus("エラー: " + e);
    }
  }

  // --- 見積もり（ラベル「見積:3pt」など） ---

  /** 見積もりのラベル（今の単位の「見積:3pt」など）がリポジトリになければ作る（色をそろえるため。作れなくても、付けるときに GitHub が作る） */
  async function ensureEstimateLabel(value: number) {
    const name = estimateLabel(value, estimateUnit);
    if (labels.some((l) => l.name === name)) return;
    try {
      await invokeWrite("create_label", { owner, repo, name, color: ESTIMATE_COLOR, description: `見積もり（${UNITS[estimateUnit].name}）` });
      await loadLabels();
    } catch {
      // つながらないとき・もうあるときなど。付けるときに GitHub が作る
    }
  }

  /** Issue の見積もりを、今の単位で付け替える（null なら外す） */
  async function setEstimate(n: number, value: number | null) {
    const current = [...issues, ...closedIssues].find((i) => i.number === n);
    if (!current) return;
    if (value !== null) await ensureEstimateLabel(value);
    await updateIssue(n, { labels: withEstimate(current.labels.map((l) => l.name), value, estimateUnit) });
  }

  // --- コメント ---

  async function listComments(issueNumber: number): Promise<GitHubComment[]> {
    try {
      const result = await invoke("list_comments", { owner, repo, issueNumber });
      return JSON.parse(result as string);
    } catch (e) {
      setStatus("コメント取得エラー: " + e);
      return [];
    }
  }

  async function createComment(issueNumber: number, body: string) {
    try {
      const issueTitle = [...issues, ...closedIssues].find((i) => i.number === issueNumber)?.title || issueRef(issueNumber);
      const result = await invokeWrite("create_comment", {
        owner, repo, issueNumber, body,
        notice: eventNotice("comment_added", `💬 {issue} ${issueTitle} にコメント`),
      });
      setStatus(`${issueRef(issueNumber)} にコメントを追加${isPending(result) ? PENDING_NOTE : ""}`);
    } catch (e) {
      setStatus("コメントを送れませんでした: " + friendlyError(e));
      throw e;
    }
  }

  // --- Issue テンプレート（.github/ISSUE_TEMPLATE） ---

  async function listIssueTemplates(): Promise<IssueTemplate[]> {
    return await invoke<IssueTemplate[]>("list_issue_templates", { owner, repo });
  }

  /** テンプレートをリポジトリに置く（1 つのコミット）。置いたあとの一覧を返す */
  async function addIssueTemplates(templates: IssueTemplate[]): Promise<IssueTemplate[]> {
    const names = templates.map((t) => t.name.replace(/^\S+\s/, "")).join("・");
    const list = await invoke<IssueTemplate[]>("add_issue_templates", { owner, repo, templates, message: `Issue テンプレートを追加（${names}）` });
    setStatus(`Issue テンプレートを置きました（${names}）`);
    return list;
  }

  // --- 変更の履歴（タイムライン）。つながっているときだけ ---

  async function listTimeline(issueNumber: number): Promise<TimelineEvent[]> {
    const result = await invoke("list_issue_timeline", { owner, repo, issueNumber });
    return JSON.parse(result as string);
  }

  // --- サブイシュー（親子）。つながっているときだけ使える ---

  /** 手元の一覧（開いている・閉じた）の Issue を書き換える */
  function patchIssue(n: number, change: (i: GitHubIssue) => GitHubIssue) {
    setIssues((prev) => prev.map((i) => (i.number === n ? change(i) : i)));
    setClosedIssues((prev) => prev.map((i) => (i.number === n ? change(i) : i)));
  }

  /** 子を閉じた・開き直したら、同じリポジトリの親の「完了した子の数」も合わせる */
  function adjustParentOf(child: GitHubIssue | undefined, completed: number) {
    const parent = parseIssueApiUrl(child?.parent_issue_url);
    if (parent && isSameRepo(parent, owner, repo)) {
      patchIssue(parent.number, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, 0, completed) }));
    }
  }

  async function listSubIssues(parent: number): Promise<GitHubIssue[]> {
    const result = await invoke("list_sub_issues", { owner, repo, issueNumber: parent });
    return JSON.parse(result as string);
  }

  /** 子にする（ほかの親の子なら、付け替える） */
  async function addSubIssue(parent: number, child: GitHubIssue) {
    if (!child.id || child.number <= 0) {
      throw new Error(`${issueRef(child.number)} はまだ GitHub に送っていないので、子にできません`);
    }
    const oldParent = parseIssueApiUrl(child.parent_issue_url);
    await invokeWrite("add_sub_issue", { owner, repo, issueNumber: parent, subIssueId: child.id, replaceParent: !!oldParent });
    const done = child.state === "closed" ? 1 : 0;
    if (oldParent && isSameRepo(oldParent, owner, repo)) {
      patchIssue(oldParent.number, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, -1, -done) }));
    }
    patchIssue(parent, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, 1, done) }));
    patchIssue(child.number, (i) => ({ ...i, parent_issue_url: issueApiUrl(owner, repo, parent) }));
    setStatus(`${issueRef(child.number)} を ${issueRef(parent)} の子にしました`);
  }

  /** 子の Issue を作って、つなぐ。ラベルは「種別:イシュー」「状態:未整理」と親の「分野」、マイルストーンは親と同じ */
  async function createSubIssue(parent: GitHubIssue, title: string): Promise<GitHubIssue> {
    const labelNames = ["種別:イシュー", "状態:未整理", ...parent.labels.map((l) => l.name).filter((n) => n.startsWith("分野:"))];
    const result = await invokeWrite("create_issue", {
      owner, repo,
      title, body: "",
      labels: labelNames,
      milestone: parent.milestone?.number ?? null,
      assignees: null,
      notice: eventNotice("issue_created", `📝 {issue} ${title} を作成`),
    });
    const created = JSON.parse(result as string) as GitHubIssue;
    setIssues((prev) => [created, ...prev.filter((i) => i.number !== created.number)]);
    if (isPending(result) || !created.id) {
      throw new Error(`${title} は作りましたが、まだ GitHub に送れていないので、子にはつなげていません。送れたあとで「既存の Issue をつなぐ」からつないでください`);
    }
    await addSubIssue(parent.number, created);
    return { ...created, parent_issue_url: issueApiUrl(owner, repo, parent.number) };
  }

  /** 子から外す（Issue は消えない） */
  async function removeSubIssue(parent: number, child: GitHubIssue) {
    if (!child.id) throw new Error(`${issueRef(child.number)} の id が分からないので、外せません`);
    await invokeWrite("remove_sub_issue", { owner, repo, issueNumber: parent, subIssueId: child.id });
    patchIssue(parent, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, -1, child.state === "closed" ? -1 : 0) }));
    patchIssue(child.number, (i) => ({ ...i, parent_issue_url: null }));
    setStatus(`${issueRef(child.number)} を ${issueRef(parent)} の子から外しました`);
  }

  return {
    issues, closedIssues,
    loadIssues, loadClosedIssues, reloadCached, clear,
    closeIssue, reopenIssue, promoteIssue, changeIssueStatus, assignToMe, createIssue, createMemo, updateIssue, updateIssueBody,
    retrySending, discardSending,
    ensureEstimateLabel, setEstimate,
    listComments, createComment,
    listIssueTemplates, addIssueTemplates,
    listTimeline,
    listSubIssues, addSubIssue, createSubIssue, removeSubIssue,
  };
}
