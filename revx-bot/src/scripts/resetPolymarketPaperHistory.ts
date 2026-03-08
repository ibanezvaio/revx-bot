import { loadConfig } from "../config";
import { archiveAndResetPaperHistory } from "../polymarket/paper/resetPaperHistory";

function run(): void {
  const config = loadConfig();
  const extraTargets = [config.polymarket.paper.ledgerPath].filter(
    (target, idx, all) => String(target || "").trim().length > 0 && all.indexOf(target) === idx
  );
  const result = archiveAndResetPaperHistory({ extraTargets });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        action: "polymarket_paper_history_reset",
        timestamp: result.timestamp,
        backupDir: result.backupDir,
        backupFiles: result.backupFiles,
        resetFiles: result.resetFiles
      },
      null,
      2
    )
  );
}

run();
