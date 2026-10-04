import { loadLanguage } from "./lib/i18n";

// 言語の辞書を読んでから、画面のものを読み込む（読み込むときに決まる文も、その言語になるように。#256）
void loadLanguage().then(() => import("./start"));
