import { useEffect, useState } from "react";

/**
 * 画面いっぱいに重ねるものを出す場所（main.app。動きの設定 motion-* が効くように）。
 * 描いたあとに探す（起動したときは、読み込み中の画面と入れ替わるので、描いている途中で探すと古いほうを取ってしまう）
 */
export function usePortalHost(): Element | null {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    setHost(document.querySelector("main.app") ?? document.body);
  }, []);
  return host;
}
