// docker compose 用的 runtime 設定，對應 K8s 的 frontend-app-config ConfigMap。
// 內容形式與 k8s/frontend-config.yaml 的 config.js 完全一致，只有值不同。
window.__APP_CONFIG__ = {
  appEnv: "compose",
  ssoClientId: "compose-client-placeholder"
};
