// チーム: 自分宛ての招待を受ける（最初のセットアップ・設定 → チーム）、管理者が名前で招待する（設定 → チーム）
import { invoke } from "@tauri-apps/api/core";
import type { UserRepo } from "./auth";

/** GitHub のアカウントを作るページ */
export const SIGNUP_URL = "https://github.com/signup";

/** 招待が切れるまでの日数（GitHub の決まり） */
export const INVITATION_DAYS = 7;

export interface Person {
  login: string;
  avatar_url: string;
}

/** リポジトリへの招待（自分宛て・送ったもの、どちらも同じ形） */
export interface RepoInvitation {
  id: number;
  repository: { full_name: string; name: string; owner: Person; private: boolean };
  inviter: Person | null;
  invitee: Person | null;
  /** read / triage / write / maintain / admin */
  permissions: string;
  created_at: string;
  expired?: boolean;
  /** 招待を受けるページ */
  html_url: string;
}

/** 組織への招待（まだ受けていないもの） */
export interface OrgInvitation {
  organization: Person;
  role: string;
  state: string;
}

export interface MyInvitations {
  repos: RepoInvitation[];
  orgs: OrgInvitation[];
}

export const listMyInvitations = async () => JSON.parse(await invoke<string>("list_my_invitations")) as MyInvitations;
export const answerInvitation = (id: number, accept: boolean) => invoke<void>("answer_invitation", { id, accept });
/** 自分用のリポジトリを作る（README つき） */
export const createMyRepo = async (name: string, isPrivate: boolean) =>
  JSON.parse(await invoke<string>("create_my_repo", { name, private: isPrivate })) as UserRepo;

/** 組織への招待を受けるページ（アプリには組織の権限 write:org がないので、GitHub の画面で受ける） */
export const orgInvitationUrl = (org: string) => `https://github.com/orgs/${encodeURIComponent(org)}/invitation`;

export interface Member extends Person {
  /** admin / maintain / write / triage / read */
  role_name?: string;
}

export interface TeamOverview {
  /** 自分がこのリポジトリの管理者か（招待できるか） */
  admin: boolean;
  /** 書き込めるか（メンバーを読めるか） */
  push: boolean;
  /** 持ち主が組織か（権限を選べる） */
  organization: boolean;
  members: Member[];
  /** メンバーを読めなかったとき、その理由（トークンの権限が足りないときは直し方つき） */
  members_error?: string | null;
  /** 送った招待（管理者でなければ null） */
  invitations: RepoInvitation[] | null;
  /** 送った招待を読めなかったとき、その理由（このときは招待もできないことが多い） */
  invitations_error?: string | null;
}

export const teamOverview = async (owner: string, repo: string) =>
  JSON.parse(await invoke<string>("team_overview", { owner, repo })) as TeamOverview;

export type InviteStatus = "invited" | "already" | "no_user" | "forbidden" | "invalid" | "failed";

export interface InviteOutcome {
  status: InviteStatus;
  message: string | null;
}

export const inviteMember = (owner: string, repo: string, username: string, permission: string | null) =>
  invoke<InviteOutcome>("invite_member", { owner, repo, username, permission });
export const cancelInvitation = (owner: string, repo: string, id: number) => invoke<void>("cancel_invitation", { owner, repo, id });
/** メンバーを外す（管理者だけ。組織のリポジトリでは、組織のメンバーとしての権限は残る） */
export const removeMember = (owner: string, repo: string, username: string) => invoke<void>("remove_member", { owner, repo, username });

/** 権限の名前（GitHub の名前 → 画面の名前） */
export const ROLE_LABELS: Record<string, string> = {
  admin: "管理",
  maintain: "運営",
  write: "書き込み",
  push: "書き込み",
  triage: "整理",
  read: "読むだけ",
  pull: "読むだけ",
};

/** 組織のリポジトリで選べる権限（招待のとき。GitHub に送る名前） */
export const INVITE_PERMISSIONS: { value: string; label: string }[] = [
  { value: "push", label: "書き込み（はじめはこれ）" },
  { value: "maintain", label: "運営（設定の一部も変えられる）" },
  { value: "triage", label: "整理（Issue の整理だけ）" },
  { value: "pull", label: "読むだけ" },
  { value: "admin", label: "管理（招待もできる）" },
];

/**
 * GitHub のユーザー名に使える形（英数字とハイフン、先頭は英数字、39 文字まで）。
 * 今は続いたハイフン・末尾のハイフンも作れないが、昔のアカウントにはあるので、ここでは通して GitHub の返事に任せる
 */
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * 貼った文字から、招待する名前を取り出す。改行・カンマ・空白・読点で区切り、@ と URL の前半は外す。
 * 同じ名前は 1 つにまとめる（大文字・小文字は区別しない）。名前の決まりに合わないものは invalid に分ける
 */
export function parseNames(text: string): { names: string[]; invalid: string[] } {
  const names: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,，、;；]+/)) {
    const name = raw.replace(/^https?:\/\/github\.com\//i, "").replace(/^@/, "").replace(/\/+$/, "");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (USERNAME.test(name) ? names : invalid).push(name);
  }
  return { names, invalid };
}

/** 招待が切れるまで、あと何日か（0 以下なら切れている） */
export function daysLeft(createdAt: string, now: number = Date.now()): number {
  const elapsed = Math.floor((now - Date.parse(createdAt)) / 86400000);
  return INVITATION_DAYS - elapsed;
}
