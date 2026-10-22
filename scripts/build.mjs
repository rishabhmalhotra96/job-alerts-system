import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  globalName: "JobAlerts",
  outfile: "dist/Code.js",
  platform: "browser",
  target: "es2022",
  footer: {
    js: [
      "function runMvpShadow() { return JobAlerts.runMvpShadow(); }",
      "function continueMvpShadow() { return JobAlerts.continueMvpShadow(); }",
      "function runMvpDigestDelivery() { return JobAlerts.runMvpDigestDelivery(); }",
      "function runMvpWatchdog() { return JobAlerts.runMvpWatchdog(); }",
      "function beginMvpAcceptance(event) { return JobAlerts.beginMvpAcceptance(event); }",
      "function restartMvpAcceptance(event) { return JobAlerts.restartMvpAcceptance(event); }",
      "function runMvpAcceptanceBaselineReport(event) { return JobAlerts.runMvpAcceptanceBaselineReport(event); }",
      "function runMvpAcceptanceReport(event) { return JobAlerts.runMvpAcceptanceReport(event); }",
      "function resetMvpSourceCircuit() { return JobAlerts.resetMvpSourceCircuit(); }",
        "function applyMvpJobOverride() { return JobAlerts.applyMvpJobOverride(); }",
        "function clearMvpJobOverride() { return JobAlerts.clearMvpJobOverride(); }",
      "function setupMvp() { return JobAlerts.setupMvp(); }",
      "function authorizeMvpNotifications(event) { return JobAlerts.authorizeMvpNotifications(event); }",
      "function enableMvpNotifications(event) { return JobAlerts.enableMvpNotifications(event); }",
      "function installMvpTrigger(event) { return JobAlerts.installMvpTrigger(event); }",
      "function pauseMvp() { return JobAlerts.pauseMvp(); }",
      "function resumeMvpShadow() { return JobAlerts.resumeMvpShadow(); }",
      "function removeMvpTrigger() { return JobAlerts.removeMvpTrigger(); }",
    ].join("\n"),
  },
});

await copyFile("src/appsscript.json", "dist/appsscript.json");