import { useEffect, useState } from "react";
import { blobUrl } from "../lib/media";

/**
 * 中身（バイト列）を、画像・音・動画などで使える URL にする。使い終わったら消す（#255）。
 * URL は効果の中で作る。useMemo で作って後片づけで消すと、開発中に StrictMode が効果を 2 回動かしたとき、
 * 1 回目の後片づけで消えた URL がそのまま残って、画像が出なくなる。作るまでは null
 */
export function useBlobUrl(bytes: ArrayBuffer, path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = blobUrl(bytes, path);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes, path]);
  return url;
}
