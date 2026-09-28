import { invoke } from "@tauri-apps/api/core";

// --- GitHub でログイン（デバイスフロー） ---

export interface DeviceCode {
  device_code: string;
  /** ブラウザで入れるコード（WDJB-MJHT など） */
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type Poll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "done" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "failed"; message: string };

/** 「GitHub でログイン」に使う GitHub App の Client ID。空ならログインは使えない（トークンで入る） */
export const authClientId = () => invoke<string>("auth_client_id");
/** 使うリポジトリを選ぶ・足す画面（GitHub で Life Manager を入れる。入れてあれば、選び直す画面に進める） */
export const authInstallUrl = () => invoke<string>("auth_install_url");
export const authStart = () => invoke<DeviceCode>("auth_start");
/** days: この PC で使う日数（過ぎたら、鍵を消してログインし直してもらう） */
export const authPoll = (deviceCode: string, days: number) => invoke<Poll>("auth_poll", { deviceCode, days });
export const signOut = () => invoke<string>("sign_out");
/** この PC で使う期限が来て、ログインの鍵を消したか（1 回だけ true） */
export const takeLoginNotice = () => invoke<boolean>("take_login_notice");

/** この PC で使う期限の選び方 */
export const LOGIN_PERIODS = [
  { days: 30, label: "30 日" },
  { days: 90, label: "90 日" },
  { days: 180, label: "半年" },
] as const;
const LOGIN_DAYS_STORE = "login-days";

/** 前に選んだ期限（なければ 90 日） */
export function loadLoginDays(): number {
  try {
    const v = Number(localStorage.getItem(LOGIN_DAYS_STORE));
    return LOGIN_PERIODS.some((p) => p.days === v) ? v : 90;
  } catch {
    return 90;
  }
}

export function storeLoginDays(days: number) {
  try {
    localStorage.setItem(LOGIN_DAYS_STORE, String(days));
  } catch {
    // 覚えられなくても、今回は選んだ期限で入る
  }
}

/** GitHub で許可したアプリの一覧（Life Manager の許可を取り消すとき） */
export const APP_AUTHORIZATIONS_PAGE = "https://github.com/settings/apps/authorizations";

/** ログアウトしたことを、最初の画面に伝える（GitHub での許可の取り消し方を出すため） */
export const SIGNED_OUT_STORE = "signed-out";

// --- トークンの確認 ---

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoCheck extends RepoRef {
  ok: boolean;
  can_push: boolean;
  private: boolean;
  problem: "not_found" | "not_installed" | "no_issues" | "org_restricted" | "sso" | "error" | null;
  message: string | null;
}

export interface TokenReport {
  login: string;
  name: string | null;
  avatar_url: string;
  kind: "oauth" | "fine-grained" | "classic" | "app" | "unknown";
  /** "2026-12-27 00:00:00 +0900" の形。期限のないトークンは null。「GitHub でログイン」は、この PC で使う期限 */
  expires_at: string | null;
  scopes: string[] | null;
  repos: RepoCheck[];
}

/** token を渡せばそれを、渡さなければ owner/repo のプロジェクトで使うトークン（なければいつもの）を確かめる */
export const checkToken = (args: { token?: string; owner?: string; repo?: string; repos: RepoRef[] }) =>
  invoke<TokenReport>("check_token", { token: args.token ?? null, owner: args.owner ?? null, repo: args.repo ?? null, repos: args.repos });

export interface TokenOverview {
  has_default: boolean;
  default_kind: TokenReport["kind"] | null;
  projects: (RepoRef & { source: "project" | "default" | "none" })[];
}

export const tokenOverview = () => invoke<TokenOverview>("token_overview");
export const setDefaultToken = (token: string) => invoke<string>("set_token", { token });
export const setProjectToken = (owner: string, repo: string, token: string) => invoke<string>("set_project_token", { owner, repo, token });
export const clearProjectToken = (owner: string, repo: string) => invoke<string>("clear_project_token", { owner, repo });

export interface UserRepo {
  full_name: string;
  name: string;
  owner: { login: string; type: string; avatar_url: string };
  private: boolean;
  updated_at: string;
  permissions?: { push: boolean };
}

/** ログインした人が使えるリポジトリ（更新の新しい順） */
export const listUserRepos = async () => JSON.parse(await invoke<string>("list_user_repos")) as UserRepo[];

// --- 表示 ---

export const KIND_LABELS: Record<TokenReport["kind"], string> = {
  oauth: "GitHub でログイン（すべてのリポジトリ）",
  "fine-grained": "Fine-grained トークン",
  classic: "Classic トークン",
  app: "GitHub でログイン（選んだリポジトリだけ）",
  unknown: "トークン",
};

/** 期限まで何日か（期限のないトークンは null） */
export function expiryOf(report: Pick<TokenReport, "expires_at">): { date: string; days: number } | null {
  if (!report.expires_at) return null;
  // "2026-12-27 00:00:00 +0900" → Date
  const m = report.expires_at.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}) ?([+-]\d{2})(\d{2})/);
  const at = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`) : new Date(report.expires_at);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.floor((at.getTime() - Date.now()) / 86400000);
  return { date: `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`, days };
}

/** 期限が近い（この日数以内）と、画面の上で知らせる */
export const EXPIRY_WARN_DAYS = 7;

/**
 * GitHub で Fine-grained トークンを作るページ（名前・期限・権限を入れた状態で開く）。
 * 使うリポジトリ（Repository access）だけは、GitHub の決まりで先に入れられないので、利用者が選ぶ
 */
export function tokenCreateUrl(owner?: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const params = new URLSearchParams({
    name: `Life Manager ${stamp}`,
    description: "Life Manager で Issue とファイル（設定・日誌）を読み書きする",
    expires_in: "90",
    issues: "write",
    contents: "write",
    metadata: "read",
  });
  if (owner) params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/** トークンの一覧の画面（Repository access を足すとき） */
export const TOKENS_PAGE = "https://github.com/settings/personal-access-tokens";
