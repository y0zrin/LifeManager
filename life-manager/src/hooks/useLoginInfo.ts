// ログインしている人と、Life Manager App を入れてある先（作る・許可する・上げる手順で使う）
import { useCallback, useEffect, useState } from "react";
import { authInstallUrl, checkToken, listInstallations, type Installation, type TokenReport } from "../lib/auth";

export function useLoginInfo() {
  const [me, setMe] = useState<TokenReport | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installations, setInstallations] = useState<Installation[] | null>(null);

  const reloadInstallations = useCallback(async () => {
    try {
      setInstallations(await listInstallations());
    } catch {
      setInstallations([]);
    }
  }, []);

  useEffect(() => {
    checkToken({ repos: [] }).then(setMe).catch(() => {});
    authInstallUrl().then(setInstallUrl).catch(() => {});
  }, []);

  // 「GitHub でログイン」（GitHub App）のときだけ、入れてある先がある
  const byLogin = me?.kind === "app";
  useEffect(() => {
    if (byLogin) reloadInstallations();
  }, [byLogin, reloadInstallations]);

  // 自分のアカウントに入れてある分（参加しているリポジトリの持ち主の分は数えない）
  const ownInstallation = me && installations
    ? installations.find((i) => i.account.login.toLowerCase() === me.login.toLowerCase()) ?? null
    : null;

  return { me, byLogin, installUrl, installations, reloadInstallations, ownInstallation };
}
