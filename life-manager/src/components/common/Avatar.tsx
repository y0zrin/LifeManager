import type { CSSProperties } from "react";

interface AvatarProps {
  login: string;
  url?: string | null;
  alt?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/** 人の画像。画像がないとき（見本のデータなど）は、名前の頭文字の丸にする（空の src の画像を出さない） */
export function Avatar({ login, url, alt, title, className, style }: AvatarProps) {
  if (url) return <img src={url} alt={alt ?? login} title={title} className={className} style={style} />;
  return (
    <span className={`${className ?? ""} avatar-letter`} title={title} style={style} aria-hidden="true">
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}
