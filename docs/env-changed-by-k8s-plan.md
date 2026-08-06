# 以 K8s 環境變數切換 dev / uat / prod 的做法

> 對象檔案：`k8s/frontend.yaml`、`lookGo-frontend/Dockerfile`、`lookGo-frontend/nginx.conf`、`lookGo-frontend/index.html`、`docker-compose.yaml`。
> 目標：**前端只打包一次 image**，dev / uat / prod 三環境靠 K8s 設定切換。
>
> 結論先講：
>
> 1. 目前的做法對「nginx 層設定（例如後端位址）」有效，機制正確，維持不變。
> 2. 對「瀏覽器 JS 需要的設定」無效，需要額外加一層 runtime 注入。
> 3. **但 SSO 未必屬於第 2 類** —— 若採用 BFF（後端代持 token），SSO 設定一個都不用送到瀏覽器。這個決策必須先做，見 2-0。
> 4. 若確實需要注入，**主推方案 D：把 `config.js` 做成 ConfigMap，用 volume 掛進 nginx 的靜態目錄**。它避開了 envsubst 路線兩個已實測的失效模式，且改設定不需要重啟 Pod。
>
> 章節：一、現況機制與問題盤點　二、SSO 的架構決策與注入方案　三、尚未導入 SSO 時就能先做的驗證流程。
>
> 標記說明：
>
> - `【實測】` = 已在 `nginx:stable-alpine`（nginx 1.30.4）或本專案 Vite 8 建置流程上實際驗證。
> - `【待驗收】` = 依 K8s / nginx 官方文件的行為推導，尚未在本專案叢集實測，列入第三節驗收。

---

## 一、目前的 K8s 部署做法

### 1-1. 機制說明

前端 image 分兩階段建置（`Dockerfile`）：

- **Stage 1（builder）**：`npm run build` 產出 `dist/`，這是**純靜態檔**。
- **Stage 2（production）**：把 `dist/` 複製到 `/usr/share/nginx/html`，並把 `nginx.conf` 複製到 `/etc/nginx/templates/default.conf.template`。

關鍵在於 **`/etc/nginx/templates/` 這個路徑**。官方 `nginx` image 的 `ENTRYPOINT`（`/docker-entrypoint.sh`）會依序執行 `/docker-entrypoint.d/*.sh`，其中 `20-envsubst-on-templates.sh` 會在**容器每次啟動時**：

```
讀取容器環境變數
   → 對 /etc/nginx/templates/*.template 做 envsubst
   → 輸出到 /etc/nginx/conf.d/*.conf
   → 才啟動 nginx
```

`Dockerfile` 最後一行雖然覆寫了 `CMD ["nginx", "-g", "daemon off;"]`，但那與官方預設值相同，且**沒有覆寫 `ENTRYPOINT`**，所以上述注入鏈路是完整可用的。

【實測】主 entrypoint 的判斷式是 `if [ "$1" = "nginx" ] || [ "$1" = "nginx-debug" ]`，`CMD` 讓 `$1` = `nginx`，因此 `/docker-entrypoint.d/` 底下的腳本會被執行。**反過來說，任何把 `command` / `CMD` 換成非 `nginx` 開頭的寫法，都會讓整條注入鏈路失效**（`docker-compose.yaml` 目前正是踩到這點，見 1-7）。

因此 `k8s/frontend.yaml` 中的 `DNS_RESOLVER`、`BACKEND_URL` 兩個環境變數，確實能做到「同一顆 image、不同環境給不同值」。

### 1-2. 流程圖

```
┌──────────────── BUILD TIME（docker build，整個流程只跑一次）────────────────┐
│                                                                            │
│  Dockerfile  ARG NPM_RC_FILE=.npmrc-public   ← build 期參數，決定 npm 來源   │
│  Dockerfile  RUN npm run build                                             │
│        │                                                                   │
│        │   ★ 若程式碼用 import.meta.env.VITE_XXX，                          │
│        │     Vite 會在這一刻把值「字面 inline」寫進 JS ★                     │
│        ▼                                                                   │
│   dist/assets/index-a1b2c3.js      ← 產生後即凍結，一個 byte 都不會再變      │
│        │                                                                   │
│  Dockerfile  COPY --from=builder /app/dist  → /usr/share/nginx/html        │
│  Dockerfile  COPY nginx.conf → /etc/nginx/templates/default.conf.template  │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
                        ［ 同一顆 image ］
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
     ┌───────┐                ┌───────┐                ┌───────┐
     │  dev  │                │  uat  │                │ prod  │
     └───┬───┘                └───┬───┘                └───┬───┘
         │                        │                        │
   ┌─────┴──────────────── RUNTIME（容器啟動時）────────────┴─────┐
   │                                                             │
   │  ENTRYPOINT /docker-entrypoint.sh                           │
   │      └─ /docker-entrypoint.d/20-envsubst-on-templates.sh    │
   │                │                                            │
   │                │  讀 K8s 注入的環境變數                       │
   │                │    DNS_RESOLVER / BACKEND_URL              │
   │                ▼                                            │
   │      /etc/nginx/templates/default.conf.template             │
   │                    │  envsubst                              │
   │                    ▼                                        │
   │      /etc/nginx/conf.d/default.conf     ✅ 每環境不同         │
   │                                                             │
   │      /usr/share/nginx/html/*.js         ❌ 完全沒被碰到       │
   │                                                             │
   │  CMD nginx -g daemon off;                                   │
   └─────────────────────────────────────────────────────────────┘
```

### 1-3. 請求路徑圖

```
  瀏覽器                      frontend Pod (nginx)              backend Pod
    │                              │                                │
    │  GET /                       │                                │
    ├─────────────────────────────►│ try_files → /index.html        │
    │◄─────────────────────────────┤ 靜態檔（打包時就固定）           │
    │                              │                                │
    │  GET /api/v1/...             │  set $backend_upstream         │
    ├─────────────────────────────►│    ${BACKEND_URL}              │
    │                              │  proxy_pass ─────────────────► │
    │                              │  （搭配 resolver 做動態 DNS，    │
    │◄─────────────────────────────┤    ClusterIP 換掉也不會卡舊 IP） │
    │                              │                                │
    │  WS  /ws                     │                                │
    ├─────────────────────────────►├──────────────────────────────► │
    │      （Upgrade，逾時拉長到 3600s 避免 STOMP 長連線被斷）         │
```

### 1-4. 目前狀態盤點

| 設定項目             | 目前位置                             | 一次打包可切換？ | 導入後的歸屬                                                      |
| -------------------- | ------------------------------------ | ---------------- | ----------------------------------------------------------------- |
| `DNS_RESOLVER`       | `nginx.conf` `resolver`              | ✅               | **nginx 層**：環境變數 + envsubst（維持現狀）                     |
| `BACKEND_URL`        | `nginx.conf` `set $backend_upstream` | ✅               | **nginx 層**：同上；瀏覽器不需知道，前端只打相對路徑 `/api/...`   |
| 安全標頭 / 快取策略  | `nginx.conf` `add_header`            | ✅               | **nginx 層**：無變數，維持現狀                                    |
| `appEnv`（環境探針） | （尚未實作）                         | ➡️               | **瀏覽器層**：方案 D，ConfigMap volume                            |
| SSO clientId         | （尚未實作）                         | ➡️               | **瀏覽器層**：方案 D。但若採 BFF 則完全不需要，見 2-0             |
| SSO issuer           | （尚未實作）                         | ➡️               | 同上；且多數情況可由 OIDC discovery 推導                          |
| SSO authorize URL    | （尚未實作）                         | ❌               | **不需要注入**，由 issuer 的 discovery 端點取得                   |
| SSO redirect_uri     | （尚未實作）                         | ❌               | **不需要注入**，由 `window.location.origin` 在 runtime 算出       |
| SSO client secret    | （尚未實作）                         | ❌               | **不存在於前端**。public client + PKCE 無此值；BFF 則留在 backend |

> 現況查核：`lookGo-frontend/src/` 目前 `import.meta.env` 與 `VITE_` 皆為 **0 處**，也尚未有 SSO 相關程式碼。
> 也就是說目前尚未踩到問題，但一旦以「SPA 自行執行 OAuth 流程 + `VITE_` 變數」的預設寫法加入 SSO 就會踩到。

導入後會形成一條清楚的分界，這也是方案 D 的核心心智模型：

```
   ┌─────────────────────────────────────────────────────────────┐
   │  「nginx 自己要用的」  →  環境變數  →  envsubst  →  設定檔     │
   │      DNS_RESOLVER / BACKEND_URL                             │
   ├─────────────────────────────────────────────────────────────┤
   │  「瀏覽器要用的」      →  檔案      →  volume   →  靜態資源    │
   │      appEnv / ssoClientId / issuer                          │
   └─────────────────────────────────────────────────────────────┘
```

### 1-5. ⚠️ 最重要的運維風險：nginx 模板變數沒定義會讓 Pod 起不來

這是整套機制**唯一會造成全站中斷**的失效模式，優先於本文件所有其他事項。

envsubst 只做「有定義才替換」。模板裡若出現一個環境中不存在的 `${FOO}`，envsubst 會把 `${FOO}` **原樣留下**，接著 nginx 會把它當成自己的變數來解析：

【實測】模板含未定義的 `${NEVER_SET_VAR}`，容器啟動結果：

```
20-envsubst-on-templates.sh: Running envsubst on ... to /etc/nginx/conf.d/default.conf
/docker-entrypoint.sh: Configuration complete; ready for start up
2026/08/05 13:26:03 [emerg] 1#1: unknown "never_set_var" variable
nginx: [emerg] unknown "never_set_var" variable
```

**容器直接啟動失敗 → K8s 進入 CrashLoopBackOff → 前端整站不可用。**

推論：

- **ConfigMap 少一個 key，等於前端掛掉**，而且失敗發生在 nginx 啟動階段，probe 也救不了。
- envsubst **不支援** `${VAR:-default}` 這種預設值語法（那是 shell 的能力，不是 envsubst 的），沒有自我防禦手段。

#### 這正是方案 D 最實質的價值：把觸發點數量固定住

若走 envsubst 路線（方案 A），**每新增一個 SSO 設定，就多一個 CrashLoop 觸發點**，而且觸發點數量會隨業務需求持續成長。

採用方案 D 之後，`nginx.conf` 裡的 `${...}` **永遠只有 `DNS_RESOLVER` 與 `BACKEND_URL` 兩個**——它們屬於基礎設施，設定一次之後幾乎不會再動；所有會頻繁增減的瀏覽器層設定都走檔案，不經過 nginx 設定解析器。

```
  方案 A：CrashLoop 觸發點 = 2 + N（N 隨 SSO / 前端設定數量成長）
  方案 D：CrashLoop 觸發點 = 2（固定，且是很少變動的基礎設施參數）
```

**強制規則（縮小後仍然適用）**：`nginx.conf` 模板裡出現的每一個 `${...}`，都必須在**每一個環境**的 env ConfigMap 裡有對應 key。新增 nginx 層變數時必須同步三份 ConfigMap，建議用 kustomize base 統一管理避免漏改。

### 1-6. 現有待修項目

| #   | 位置                                                                      | 問題                                                                                                                                                                               | 建議                                                                | 優先 |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---- |
| 1   | `k8s/frontend.yaml` `NPM_RC_FILE`                                         | 它是 `Dockerfile` 的 build `ARG`，放在 runtime `env` **完全沒有作用**。而且值填的是 `settings-nexus.xml`（Maven 的 settings 檔名），Dockerfile 期待的卻是 `.npmrc-*`，連型別都放錯 | 從 Deployment 移除，改用 `docker build --build-arg NPM_RC_FILE=...` | 高   |
| 2   | `k8s/backend.yaml` `MVN_SETTINGS`                                         | **與第 1 項完全相同的錯誤**：`settings-nexus.xml` 是 backend `Dockerfile` 的 build `ARG`，放在 runtime `env` 沒有作用                                                              | 一併移除，改走 `--build-arg`                                        | 高   |
| 3   | `k8s/frontend.yaml` `image: ...:latest` + `imagePullPolicy: IfNotPresent` | 無法保證三環境跑的是同一顆 image，也無法 rollback                                                                                                                                  | 改用 immutable tag（commit SHA）                                    | 高   |
| 4   | `k8s/frontend.yaml` env 硬編碼                                            | 三環境仍需維護三份 yaml，且容易漏掉某個變數（會觸發 1-5 的 CrashLoop）                                                                                                             | 改用 ConfigMap + kustomize overlay                                  | 高   |
| 5   | `docker-compose.yaml` frontend 區塊                                       | 走的路徑與 K8s 完全不同，且目前無法啟動（詳見 1-7）                                                                                                                                | 改為與 K8s 一致的 templates 機制                                    | 中   |
| 6   | envsubst 未設過濾條件                                                     | **並非安全問題，見下方修正說明**。純粹是預防日後新增的環境變數與 nginx 內建變數撞名                                                                                                | 設定 `NGINX_ENVSUBST_FILTER` 只允許自訂變數                         | 低   |

#### 關於第 6 項的修正說明（原先的理由是錯的）

過去認為「envsubst 做全域替換，K8s 自動注入的 `BACKEND_SERVICE_PORT`、`FRONTEND_SERVICE_HOST` 有誤觸風險」。**這個描述不正確。**

【實測】`20-envsubst-on-templates.sh` 的實際邏輯是先組出一份白名單再傳給 envsubst：

```sh
defined_envs=$(printf '${%s} ' $(awk -v filter="$filter" 'END { for (name in ENVIRON) { print ( name ~ filter ) ? name : "" } }' < /dev/null))
envsubst "$defined_envs" < "$template" > "$output_path"
```

envsubst 拿到的是**明確的變數清單**，只有「環境中真實存在的變數」才會被替換。nginx 的 `$host`、`$uri`、`$proxy_add_x_forwarded_for` 除非剛好有同名環境變數，否則絕不會被動到。

實測注入 `BACKEND_SERVICE_PORT`、`FRONTEND_SERVICE_HOST`、`KUBERNETES_SERVICE_HOST` 後，產生的設定檔：

```
5:    resolver 8.8.8.8 valid=10s;
18:        try_files $uri $uri/ /index.html;
23:        set $backend_upstream backend-dev:8080;
25:        proxy_set_header Host $host;
26:        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

nginx 變數完好無損。因此**現況沒有誤觸風險**（K8s 注入的變數全為大寫，nginx 內建變數全為小寫，本來就不會相交）。設 filter 仍是好習慣，但屬於預防性措施，不需要優先處理：

```yaml
- name: NGINX_ENVSUBST_FILTER
  value: '^(DNS_RESOLVER|BACKEND_URL)$' # 採方案 D 後，白名單就只有這兩個
```

### 1-7. `docker-compose.yaml` 與 K8s 路徑不一致（且目前為壞的）

`docker-compose.yaml` 的 frontend 區塊把 `nginx.conf` 掛到 `/etc/nginx/conf.d/default.conf.template`，並覆寫 `command` 自行執行 envsubst：

```yaml
volumes:
  - ../lookGo-frontend/nginx.conf:/etc/nginx/conf.d/default.conf.template:ro
command: /bin/sh -c "envsubst '$$BACKEND_URL' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"
```

問題有兩個：

1. **繞過官方 templates 機制**：覆寫 `command` 後 `$1` 變成 `/bin/sh`，主 entrypoint 的 `if [ "$1" = "nginx" ]` 判斷不成立，`/docker-entrypoint.d/` 底下所有腳本被整批跳過（直接 `exec "$@"`）。因此**用 compose 測不到 K8s 實際使用的注入鏈路**。
2. **目前無法啟動**：該 envsubst 的過濾清單只有 `'$BACKEND_URL'`，而 `.env` 也未定義 `DNS_RESOLVER`。結果 `nginx.conf` 的 `resolver ${DNS_RESOLVER} valid=10s;` 會原封不動留在產生的設定檔中，nginx 啟動時解析失敗（與 1-5 是同一類失效）。

建議修法（讓 compose 與 K8s 走同一條路，並加上方案 D 的 volume）：

```yaml
volumes:
  - ../lookGo-frontend/nginx.conf:/etc/nginx/templates/default.conf.template:ro # 改掛 templates 目錄
  - ./local-cfg:/usr/share/nginx/html/cfg:ro # 對應 K8s 的 ConfigMap volume
# 移除 command 覆寫，交還給官方 entrypoint
environment:
  - DNS_RESOLVER=${DNS_RESOLVER:-127.0.0.11} # Docker user-defined network 的內建 DNS；.env 也需補上
  - BACKEND_URL=${BACKEND_URL}
```

`lookGo-infra/local-cfg/config.js`（本機版設定，內容形式與 ConfigMap 完全一致）：

```js
window.__APP_CONFIG__ = { appEnv: 'local', ssoClientId: 'local-placeholder' };
```

> `127.0.0.11` 是 Docker 在 user-defined network（本專案的 `lookGo-network`）中提供的內建 DNS，可正確解析 service 名稱。
> 修好之後，`docker compose up frontend` 就與 K8s 走**完全相同**的兩條注入鏈路（env→envsubst、檔案→volume），3-8 的表格也隨之更新。

---

## 二、SSO 的架構決策與注入方案

### 2-0. 先做架構決策：SSO 設定到底需不需要送進瀏覽器

**這一步必須先做，否則後面的注入方案有可能完全不需要。**

「`clientId` / `authorizeUrl` 必須送達前端 JS」這個前提，**只在 SPA 自己執行 OAuth 流程時才成立**。目前 IETF 的 _OAuth 2.0 for Browser-Based Applications_ BCP，把 **BFF（Backend-For-Frontend，後端代持 token）列為首選**，SPA 自持 token（public client + PKCE）列為次選。

本專案的條件恰好非常適合 BFF：已經有 Spring Boot 後端、已經有 JWT、已經有 Redis 可存 session、nginx 已經在 proxy `/api/`、且 `backend-secret` 已有 `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` 走 `secretKeyRef` 的先例。

```
                        ┌─────────────────────────────────┐
                        │  SSO 要走哪一種架構？             │
                        └───────────────┬─────────────────┘
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              ▼                                                    ▼
   ┌──────────────────────────┐                    ┌──────────────────────────────┐
   │ BFF（後端代持 token）      │                    │ SPA public client + PKCE      │
   │ Spring Security           │                    │ 前端自己組跳轉網址、自己拿 token │
   │ OAuth2 Client             │                    │                               │
   └──────────┬───────────────┘                    └──────────────┬───────────────┘
              │                                                    │
              │ 瀏覽器只打 /oauth2/authorization/{provider}          │ 瀏覽器需要 clientId
              │ clientId / secret / authorizeUrl 全留在後端          │ （+ issuer）
              │                                                    │
              ▼                                                    ▼
   ★ SSO 完全不需要前端注入機制                          ★ 需要注入 → 採用方案 D
     （appEnv 等非 SSO 設定仍建議用方案 D）
```

BFF 的額外好處：token 不落地到瀏覽器（無 XSS 竊取 token 的風險）、client secret 可以正常使用、與現有 JWT/Redis session 機制天然相容。

**即使選了 SPA + PKCE，需要注入的變數也遠少於三個：**

| 變數           | 是否需要注入  | 理由                                                                                          |
| -------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `redirectUri`  | ❌ 不需要     | 用 `window.location.origin + '/callback'` 在 runtime 算出來。少一個變數就少一個環境間出錯的點 |
| `authorizeUrl` | ❌ 通常不需要 | 標準 OIDC 有 discovery：`{issuer}/.well-known/openid-configuration`。只要給 `issuer`          |
| `issuer`       | ⚠️ 視情況     | 若三環境用同一個 IdP 的不同 realm 才需要                                                      |
| `clientId`     | ✅ 需要       | 這是唯一真正必須注入的值                                                                      |
| `clientSecret` | ❌ **不存在** | public client + PKCE 沒有 client secret。**前端 Pod 不該持有任何 secret**                     |

> **無論選哪一條路，方案 D 都值得先導入**——`appEnv` 這種環境探針、以及未來任何前端 runtime 設定都會用到它，而且它同時是第三節的驗收出口。

### 2-1. 為什麼瀏覽器端設定不能沿用現有的 envsubst 機制

要先區分兩個**互相獨立**的問題：

```
  問題 A：值「從哪裡來」？        → ConfigMap / Secret 解決  ✅
  問題 B：值「怎麼進到瀏覽器」？   → 需要一條送達路徑         ❌
```

`BACKEND_URL` 之所以沒事，是因為它**從頭到尾只活在 nginx 層**——瀏覽器根本不需要知道後端位址，前端只打相對路徑 `/api/...`，由 nginx 自己 proxy 出去。

瀏覽器端設定不一樣：`clientId` 是**瀏覽器要拿去組跳轉網址**的，值必須送達前端 JS。而 `dist/*.js` 是打包當下就燒死的靜態檔，envsubst 只處理 `/etc/nginx/templates/`，永遠不會回頭修改已產生的 JS。

**方案 D 的解法是：不要試圖修改已打包的 JS，而是額外送一個檔案給瀏覽器。** 這個檔案不由 image 提供，而是由 ConfigMap 以 volume 掛進 nginx 的靜態目錄——對 nginx 而言它就是一個普通靜態檔，完全不經過設定檔解析器。

```
  ┌── ConfigMap: frontend-config（環境變數）───────────────────────────┐
  │   DNS_RESOLVER / BACKEND_URL                                      │
  │        │  envFrom                                                 │
  │        ▼                                                          │
  │   容器環境變數 ──► envsubst ──► /etc/nginx/conf.d/default.conf  ✅  │
  └───────────────────────────────────────────────────────────────────┘

  ┌── ConfigMap: frontend-app-config（檔案）──────────────────────────┐
  │   config.js: window.__APP_CONFIG__={...}                          │
  │        │  volumeMount                                             │
  │        ▼                                                          │
  │   /usr/share/nginx/html/cfg/config.js                             │
  │        │  nginx 當一般靜態檔回傳（不解析內容）                       │
  │        ▼                                                          │
  │   瀏覽器 window.__APP_CONFIG__                                ✅  │
  └───────────────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────────────┐
  │   dist/*.js（image 內，打包時凍結）                            ❌  │
  │   永遠不會被任何 runtime 機制改到——所以前端不可以讀 VITE_ 變數      │
  └───────────────────────────────────────────────────────────────────┘
```

### 2-2. 方案 D（主推）：ConfigMap 以 volume 掛成靜態設定檔

#### 2-2-1. ConfigMap

env 與檔案分成兩份 ConfigMap，職責清楚、變更頻率也不同：

```yaml
# ① nginx 層 —— 基礎設施參數，很少變動
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
data:
  DNS_RESOLVER: 'kube-dns.kube-system.svc.cluster.local'
  BACKEND_URL: 'backend-service.default.svc.cluster.local:8080'
---
# ② 瀏覽器層 —— 前端 runtime 設定，會隨業務需求增減
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-app-config
data:
  config.js: |
    window.__APP_CONFIG__ = {
      appEnv: "dev",
      ssoClientId: "dev-client-id-0000"
    };
```

> dev / uat / prod 各一份，用 kustomize overlay 產生。
> ② 的內容是**純文字**，不會被任何解析器當程式碼看待，因此**沒有字元限制**。

#### 2-2-2. Deployment

```yaml
containers:
  - name: frontend
    image: docker.io/library/lookgo-frontend:<commit-sha>
    envFrom:
      - configMapRef:
          name: frontend-config # ① → 環境變數 → envsubst
    volumeMounts:
      - name: app-config
        mountPath: /usr/share/nginx/html/cfg # ② → 檔案；掛「目錄」，不可用 subPath
        readOnly: true
volumes:
  - name: app-config
    configMap:
      name: frontend-app-config
      # 刻意不加 optional: true —— ConfigMap 不存在時應在部署階段就失敗，
      # 而不是讓 Pod 起來後對外提供一個沒有設定的登入頁
```

> **前端 Pod 不要掛任何 Secret。** public client + PKCE 沒有 client secret；即使有，掛進前端 Pod 也毫無用途——任何能讀 Pod spec 或 `kubectl exec` 的人都拿得到，等於平白擴大暴露面。機密值一律留在 backend（沿用 `backend-secret` 既有模式）。

#### 2-2-3. `nginx.conf`（新增一段，不含任何變數）

```nginx
location = /cfg/config.js {
    add_header Cache-Control "no-store";   # 必須關閉快取，否則換環境仍讀到舊值
}
```

注意這段**沒有 `${...}`**，因此不增加 1-5 的 CrashLoop 觸發點。`location = ` 是精確匹配，優先權高於 `location /` 的 `try_files`，也不會落入 `location /assets/` 的 `immutable` 長快取。

#### 2-2-4. `index.html`

```html
<body>
  <div id="root"></div>
  <script src="/cfg/config.js"></script>
  <!-- 先讀 runtime 設定 -->
  <script type="module" src="/src/main.tsx"></script>
</body>
```

【實測】用本專案的 Vite 8 建置後，產出的 HTML 會是：

```html
<head>
  ...
  <script type="module" crossorigin src="/assets/index-BZ1-Lupn.js"></script>
</head>
<body>
  <div id="root"></div>
  <script src="/cfg/config.js"></script>
</body>
```

**module script 被提升到 `<head>`，設定檔留在 `<body>`，順序看起來反了。** 但執行順序仍然正確：`type="module"` 具 defer 語意（文件解析完才執行），而 classic script 在 parser 走到時同步執行，因此設定一定先載入。**驗收時看到這個產出不要誤判成 bug。**

#### 2-2-5. `public/cfg/config.js` 佔位檔（必要）

```js
// lookGo-frontend/public/cfg/config.js
// 僅供本機 npm run dev 使用；容器內會被 ConfigMap volume 整個蓋掉。
window.__APP_CONFIG__ = { appEnv: 'local', ssoClientId: 'local-placeholder' };
```

這一份檔案同時解決三件事：

1. **`npm run dev` 才有設定可讀**（Vite dev server 沒有 nginx 也沒有 volume，否則會拿到 404 → `window.__APP_CONFIG__` undefined）。
2. 消除 Vite build 對 `<script src="...">` 無法 bundle 的警告（實測該警告不會中斷 build，但補上佔位檔後就名正言順）。
3. 容器內不受影響：volume 掛在 `/usr/share/nginx/html/cfg`，會**整個覆蓋** image 內同路徑的目錄，ConfigMap 的版本勝出。

#### 2-2-6. 前端讀取方式（含防禦性預設值）

```ts
// src/constants/appConfig.ts
type AppConfig = { appEnv: string; ssoClientId: string };

const defaults: AppConfig = { appEnv: 'unknown', ssoClientId: '' };

export const appConfig: AppConfig = {
  ...defaults,
  ...(window as unknown as { __APP_CONFIG__?: Partial<AppConfig> })
    .__APP_CONFIG__,
};
```

**禁止新增 `import.meta.env.VITE_*`**——那會在 build time 被 inline，直接讓「一次打包」失效。

#### 2-2-7. 三個必須注意的行為

| 項目                   | 說明                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **不可用 `subPath`**   | 【待驗收】K8s 明確規定：以 `subPath` 掛載的 ConfigMap **不會收到更新**。要自動同步就必須掛成目錄。這也是路徑設計成 `/cfg/config.js` 而非根目錄 `/config.js` 的原因——掛在根目錄會把整個 `dist/` 蓋掉 |
| **同步是「最終一致」** | 【待驗收】ConfigMap volume 的更新有 kubelet sync period + cache TTL 的延遲（約一分鐘級），不是即時。若需要立即生效仍可 `rollout restart`，但**不是必要的**                                          |
| **瀏覽器仍需重新載入** | 檔案更新後，已開啟的分頁不會自動拿到新值。`Cache-Control: no-store` 保證下次載入必定重抓                                                                                                            |

#### 2-2-8. 方案 D 為什麼優於 envsubst 路線

對應第一節兩個已實測的失效模式：

| 失效模式             | envsubst 路線（方案 A）                                              | 方案 D                                        |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| 值含 `'`             | 【實測】`[emerg] unexpected "d" in default.conf:10` → **容器起不來** | 純文字檔，無此問題                            |
| 值含 `$`             | 【實測】`abc$host` 回傳成 `abclocalhost` → **靜默資料汙染**          | 純文字檔，無此問題                            |
| 設定漏一個 key       | 【實測】CrashLoopBackOff，**全站中斷**                               | 該欄位為 undefined，前端用 2-2-6 的預設值降級 |
| 改設定要重啟 Pod     | 是（envsubst 只在啟動跑一次）                                        | 否（volume 自動同步）                         |
| CrashLoop 觸發點數量 | 2 + N，隨設定增加而成長                                              | 固定 2 個                                     |

### 2-3. 其他方案（備查）

以下三個方案在本專案**不採用**，列出供決策追溯。

#### 方案 A：由 nginx.conf 直接產生 `/config.js`

```nginx
location = /config.js {
    default_type application/javascript;
    add_header Cache-Control "no-store";
    return 200 'window.__APP_CONFIG__={"appEnv":"${APP_ENV}","ssoClientId":"${SSO_CLIENT_ID}"};';
}
```

【實測】機制本身可運作（回應正確、`no-store` 正常）。**不採用的原因**：值會被貼進 nginx 設定檔並被解析器解讀，導致 2-2-8 表格中的三種失效；且每新增一個設定就多一個 CrashLoop 觸發點。

若因故無法使用 volume（例如受限的 PaaS 環境），方案 A 是唯一不需要額外掛載的選項，但必須加上硬性約束：**所有注入值只允許 `[A-Za-z0-9._:/-]`**，不得含引號、`$`、`;`、`{`、`}`。

#### 方案 C：獨立 entrypoint script 注入

在 `public/` 放 `config.js.template`，另加 `/docker-entrypoint.d/99-app-config.sh` 做 envsubst 產生靜態檔。

優點與方案 D 相同（純靜態檔、shell 可用 `${VAR:-default}` 降級）。**不採用的原因**：多一個檔案、多一支腳本，且有權限陷阱——Windows 上 git 不保留 exec bit，而 entrypoint 對非執行檔是**靜默忽略**的：

```sh
*.sh)
  if [ -x "$f" ]; then "$f" else entrypoint_log "$0: Ignoring $f, not executable";
```

沒有 exec bit 時容器仍會正常啟動，只是設定檔沒被產生，**失敗方式比 CrashLoop 更難察覺**。方案 D 用宣告式的 volume 達成同樣效果，沒有這個風險。

#### 方案 B：SSO 設定由後端提供 endpoint

```
  瀏覽器  ──GET /api/v1/config──►  nginx  ──►  backend（runtime 讀 env / Secret）
          ◄── { ssoClientId, issuer } ──────────────────────────────
```

優點：設定集中在後端，可只回傳公開欄位。**不採用的原因**：

1. 這支 endpoint 必須在認證中介層**之前**放行（未登入就要讀得到），Spring Security 需額外開白名單。
2. 前端**啟動流程被綁在後端可用性上**——登入頁在 config 回來之前無法渲染，需要處理 loading 狀態與失敗重試。
3. 這次請求發生在 **JS bootstrap 之後**，是真正序列化的首屏延遲；方案 D 則在 document parse 期就完成。**這才是關鍵差異，不是「有沒有多一次請求」。**

> 若已決定走 BFF（2-0），方案 B 多半也不需要——後端既然自己跑 OAuth 流程，就沒有什麼設定要交給前端了。

### 2-4. 方案比較

|                          | **方案 D（ConfigMap volume）**                                                        | 方案 A（nginx 產生 config.js）                   | 方案 C（entrypoint script）                   | 方案 B（後端 endpoint）                      |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- | -------------------------------------------- |
| 改動範圍                 | `nginx.conf`（1 段無變數）+ `index.html` + `public/cfg/config.js` + Deployment volume | `nginx.conf` + `index.html` + `public/config.js` | `Dockerfile` + 腳本 + template + `index.html` | backend + 前端啟動流程                       |
| 額外請求                 | 1 次（同源同連線，document parse 期完成；`no-store` 故每次載入重抓）                  | 同 D                                             | 同 D                                          | 1 次，發生在 **JS bootstrap 之後**，阻塞首屏 |
| **設定漏 key 時**        | ✅ 欄位 undefined，前端用預設值降級                                                   | ❌ **CrashLoopBackOff（全站中斷）**              | ✅ `${VAR:-default}` 降級                     | ✅ 後端回預設值或 4xx                        |
| **ConfigMap 整份不存在** | ✅ Pod 卡 `ContainerCreating`，**部署階段就失敗**（大聲）                             | ❌ CrashLoop                                     | ❌ 靜默產生空設定                             | ✅ API 錯誤可見                              |
| **值含特殊字元**         | ✅ 純文字檔，任意字元安全                                                             | ❌ 引號炸掉設定檔；`$` 被 nginx 展開（靜默汙染） | ✅ 純靜態檔，安全                             | ✅ JSON 序列化，安全                         |
| **改設定是否需重啟 Pod** | ✅ 不需要（volume 自動同步，最終一致）                                                | ❌ 需 `rollout restart`                          | ❌ 需 `rollout restart`                       | ✅ 不需要                                    |
| CrashLoop 觸發點         | 2（固定）                                                                             | 2 + N（隨設定成長）                              | 2（固定）                                     | 2（固定）                                    |
| 本機 `npm run dev`       | 需 `public/cfg/config.js` 佔位檔                                                      | 需 `public/config.js` 佔位檔                     | template 產物即佔位                           | 需後端跑著                                   |
| 機密值控管               | 值會送到瀏覽器，僅適合公開設定                                                        | 同 D                                             | 同 D                                          | 可只回傳公開欄位                             |
| 設定是否宣告式           | ✅ 完全宣告式，內容直接寫在 YAML 裡、可 review、可 diff                               | ⚠️ 值散在 env，實際輸出要 curl 才知道            | ⚠️ 同 A                                       | ✅ 由後端程式決定                            |
| 主要失敗模式             | 大聲失敗（部署階段）                                                                  | 大聲失敗（CrashLoop，但已上線才炸）              | **靜默失敗**（exec bit 掉了沒人發現）         | 大聲失敗（API 錯誤）                         |
| 推薦度                   | **★★★（採用）**                                                                       | ★★                                               | ★★                                            | ★                                            |

**選擇邏輯：**

1. 先依 2-0 決定 BFF vs SPA-PKCE。**選 BFF → SSO 不需要注入**，但 `appEnv` 等前端設定仍用方案 D。
2. 需要注入 → **方案 D**。
3. 環境不允許掛 volume（受限 PaaS）→ 方案 A，並套用字元約束。
4. 已有其他理由要讓後端集中管設定 → 才考慮方案 B。

### 2-5. 導入檢查清單

**架構決策**

1. 完成 2-0 的架構決策（BFF vs SPA-PKCE），並記錄決策理由。選 BFF 則後續 SSO 相關欄位可先只放 `appEnv`。

**前端**

2. 新增 `lookGo-frontend/public/cfg/config.js` 佔位檔，確保 `npm run dev` 可用。
3. `index.html` 在 module script 之前引入 `/cfg/config.js`（產出會被 Vite 重排，屬正常，見 2-2-4）。
4. 新增 `src/constants/appConfig.ts`，**帶防禦性預設值**（2-2-6）。
5. 全庫確認 `import.meta.env.VITE_*` 維持 0 處，並加入 lint 規則禁止新增。

**nginx**

6. `nginx.conf` 新增 `location = /cfg/config.js { add_header Cache-Control "no-store"; }`，確認未落入 `/assets/` 長快取。
7. 確認 `nginx.conf` 裡的 `${...}` **只剩 `DNS_RESOLVER` 與 `BACKEND_URL`**。

**K8s**

8. 建立 `frontend-config`（env）與 `frontend-app-config`（`config.js` 檔案）兩份 ConfigMap，dev / uat / prod 各一組，以 kustomize overlay 產生。
9. Deployment 加上 `envFrom` 與 volumeMount，**mountPath 為目錄 `/usr/share/nginx/html/cfg`，不可用 `subPath`**（否則失去自動同步）。
10. volume 的 configMap **不要加 `optional: true`**，讓 ConfigMap 缺漏在部署階段就失敗。
11. **前端 Pod 不掛任何 Secret。**
12. 確認 `nginx.conf` 用到的每一個 `${...}` 在三份 env ConfigMap 裡都有 key（依 1-5）。建議加 CI 檢查：抓模板所有 `${...}` 與 ConfigMap keys 做 diff。
13. image tag 改為 immutable（commit SHA）。
14. 移除 `k8s/frontend.yaml` 的 `NPM_RC_FILE` 與 `k8s/backend.yaml` 的 `MVN_SETTINGS`。
15. 設定 `NGINX_ENVSUBST_FILTER`（預防性，低優先）。

**本機**

16. 修復 `docker-compose.yaml`（1-7），改掛 templates 目錄、移除 `command` 覆寫、加上 `local-cfg` volume。

**驗收**

17. 依第三節執行，四項驗收條件全過。

---

## 三、尚未導入 SSO 時的驗證方式

### 3-1. 核心觀念：兩條鏈路要分開驗證

先加一個純觀測用的變數 `appEnv`，並讓 `ssoClientId` 先帶**佔位值**。

採用方案 D 之後，要驗證的是**兩條獨立的鏈路**，必須分開驗、分開判定：

```
  命題 1（nginx 層）
    同一顆 image，只換 frontend-config（env ConfigMap），
    容器內 /etc/nginx/conf.d/default.conf 的 proxy 目標就不同。
    → 需 rollout restart（envsubst 只在啟動時跑一次）

  命題 2（瀏覽器層）
    同一顆 image，只換 frontend-app-config（file ConfigMap），
    GET /cfg/config.js 的輸出就不同。
    → 不需要 rollout restart（volume 自動同步）  ★ 這是方案 D 最關鍵的性質
```

只要兩個命題都成立，未來接真實 SSO 時就只是把佔位值換成真值，程式碼與 image 都不需要更動。

而且 2-2 要加的 `/cfg/config.js` 正是這裡的測試出口——**不是丟棄式的測試程式碼**。

| 欄位          | 用途                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `appEnv`      | 純探針，肉眼直接辨識目前是哪個環境                                                         |
| `ssoClientId` | 先放佔位值，未來只改 ConfigMap 即可換成真值                                                |
| `backendUrl`  | **不要放進 config.js**。它屬於 nginx 層，用命題 1 的方式驗證即可；放進來反而讓兩條鏈路混淆 |

> 前置條件：需先啟動 Docker Desktop，否則 `docker` 與 `kind` 指令皆無法連線。

### 3-2. 層級一：純 Docker 驗證（約 2 分鐘）

先確認 image 本身支援 runtime 切換，不需要動到叢集。用 bind mount 模擬 K8s 的 ConfigMap volume。

> 以下指令的**執行目錄為 `lookGo-infra/`**（因此 build context 寫成 `../lookGo-frontend`）。

```bash
# 只打包一次，並記下 image ID
docker build -t lookgo-frontend:envtest --build-arg NPM_RC_FILE=.npmrc-public ../lookGo-frontend
docker inspect --format='{{.Id}}' lookgo-frontend:envtest

# 準備兩份「ConfigMap 的本機替身」
mkdir -p /tmp/cfg-dev /tmp/cfg-prod
echo 'window.__APP_CONFIG__={"appEnv":"dev","ssoClientId":"dev-client-0000"};'   > /tmp/cfg-dev/config.js
echo 'window.__APP_CONFIG__={"appEnv":"prod","ssoClientId":"prod-client-9999"};' > /tmp/cfg-prod/config.js

# 同一顆 image 跑兩份，差異只在 -e（nginx 層）與 -v（瀏覽器層）
docker run -d --name fe-dev  -p 8091:80 \
  -e DNS_RESOLVER=8.8.8.8 -e BACKEND_URL=backend-dev:8080 \
  -v /tmp/cfg-dev:/usr/share/nginx/html/cfg:ro  lookgo-frontend:envtest

docker run -d --name fe-prod -p 8092:80 \
  -e DNS_RESOLVER=8.8.8.8 -e BACKEND_URL=backend-prod:8080 \
  -v /tmp/cfg-prod:/usr/share/nginx/html/cfg:ro lookgo-frontend:envtest

# 命題 2：瀏覽器層（順便確認 Cache-Control: no-store 有生效）
curl -i http://localhost:8091/cfg/config.js
curl -i http://localhost:8092/cfg/config.js

# 命題 1：nginx 層（envsubst 確實在啟動時執行過）
docker exec fe-dev  grep backend_upstream /etc/nginx/conf.d/default.conf
docker exec fe-prod grep backend_upstream /etc/nginx/conf.d/default.conf

# 順帶確認 volume 只蓋掉 /cfg，沒有動到 dist
docker exec fe-dev ls /usr/share/nginx/html
```

通過條件：

- `/cfg/config.js` 兩組輸出的 `appEnv` / `ssoClientId` 完全不同，且回應含 `Cache-Control: no-store`
- `backend_upstream` 兩組不同
- `ls` 仍看得到 `index.html` 與 `assets/`（volume 沒有把 dist 蓋掉）

清理：

```bash
docker rm -f fe-dev fe-prod
```

### 3-3. 層級一之二：反向測試（確認失效行為，建議一併做）

這兩項是為了讓團隊親眼看到失效模式，避免正式環境才第一次遇到。

**(a) nginx 層變數缺漏 → 容器起不來**

```bash
# 刻意不給 BACKEND_URL
docker run -d --name fe-broken -p 8093:80 \
  -e DNS_RESOLVER=8.8.8.8 \
  -v /tmp/cfg-dev:/usr/share/nginx/html/cfg:ro lookgo-frontend:envtest

docker logs fe-broken                    # 應看到 [emerg] unknown "backend_url" variable
docker ps -a --filter name=fe-broken     # 應為 Exited，不是 Up
docker rm -f fe-broken
```

預期：容器 **Exited**。這證明 1-5 的規則是硬性要求，也說明為什麼要把觸發點數量壓到 2 個。

**(b) 瀏覽器層設定缺漏 → 前端降級，不中斷**

```bash
# 不掛 volume，模擬 config.js 不存在
docker run -d --name fe-nocfg -p 8094:80 \
  -e DNS_RESOLVER=8.8.8.8 -e BACKEND_URL=backend-dev:8080 lookgo-frontend:envtest

curl -i http://localhost:8094/cfg/config.js   # 應為 public/cfg/config.js 的佔位值（image 內建）
curl -sI http://localhost:8094/               # 應為 200，網站仍可用
docker rm -f fe-nocfg
```

預期：**站台仍然正常**，只是拿到佔位設定。這正是方案 D 相對方案 A 的核心差異——同樣是設定缺漏，一個降級、一個全站中斷。

### 3-4. 層級二：kind / K8s 驗證

建立兩個測試 namespace，各掛兩份 ConfigMap，部署**同一個 image tag**。

測試用 manifest 需刻意移除 `initContainer` 與 probe——原本的 `wait-for-backend` 在沒有 backend 的測試 namespace 會卡在 `Init` 狀態，而那與本次要驗證的事無關。

```yaml
# envswitch-test.yaml（測試用，驗證完即刪，不需進版控）
# ── Namespace 必須明確建立，否則 kubectl apply 會失敗 ──
apiVersion: v1
kind: Namespace
metadata:
  name: envtest-dev
---
apiVersion: v1
kind: Namespace
metadata:
  name: envtest-prod
---
# ① nginx 層 ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: envtest-dev
data:
  DNS_RESOLVER: 'kube-dns.kube-system.svc.cluster.local'
  BACKEND_URL: 'backend-service.envtest-dev.svc.cluster.local:8080'
---
# ② 瀏覽器層 ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-app-config
  namespace: envtest-dev
data:
  config.js: |
    window.__APP_CONFIG__ = { appEnv: "dev", ssoClientId: "dev-client-id-0000" };
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fe-test
  namespace: envtest-dev
spec:
  replicas: 1
  selector:
    matchLabels: { app: fe-test }
  template:
    metadata:
      labels: { app: fe-test }
    spec:
      containers:
        - name: frontend
          image: docker.io/library/lookgo-frontend:envtest # 兩個 namespace 必須完全相同
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
          envFrom:
            - configMapRef:
                name: frontend-config
          volumeMounts:
            - name: app-config
              mountPath: /usr/share/nginx/html/cfg # ★ 目錄掛載，不可用 subPath
              readOnly: true
      volumes:
        - name: app-config
          configMap:
            name: frontend-app-config
---
# ── Service 必須存在，下方 port-forward 才有 svc/fe-test 可指 ──
apiVersion: v1
kind: Service
metadata:
  name: fe-test
  namespace: envtest-dev
spec:
  type: ClusterIP
  selector:
    app: fe-test
  ports:
    - port: 80
      targetPort: 80
# envtest-prod 為相同結構（Namespace / 2×ConfigMap / Deployment / Service 五件），
# 只有兩份 ConfigMap 的值不同
```

```bash
kind load docker-image lookgo-frontend:envtest --name look-go   # imagePullPolicy 為 IfNotPresent，必須先載進節點
kubectl apply -f envswitch-test.yaml
kubectl -n envtest-dev  rollout status deploy/fe-test
kubectl -n envtest-prod rollout status deploy/fe-test

# 兩個終端機分別轉發
kubectl -n envtest-dev  port-forward svc/fe-test 8091:80
kubectl -n envtest-prod port-forward svc/fe-test 8092:80

curl -i http://localhost:8091/cfg/config.js
curl -i http://localhost:8092/cfg/config.js
```

> 若不想建 Service，也可改用 `kubectl -n envtest-dev port-forward deploy/fe-test 8091:80`，但正式 manifest 本來就有 Service，測試比照較貼近實際。

### 3-5. 驗收條件（四項全過才算成立）

```
┌───┬──────────────────────────────────────────────────────────────────┐
│ 1 │ image 完全相同                                                    │
│   │   kubectl get pod -A -l app=fe-test -o jsonpath=                 │
│   │     '{range .items[*]}{.status.containerStatuses[0].imageID}     │
│   │      {"\n"}{end}'                                                │
│   │   → 兩行 sha256 必須一模一樣                                       │
│   │   （用 imageID 而非 .spec.containers[].image：只有 digest 能證明   │
│   │     兩邊跑的是同一顆，tag 相同不代表內容相同）                       │
├───┼──────────────────────────────────────────────────────────────────┤
│ 2 │ 瀏覽器層設定不同（命題 2）                                         │
│   │   curl -i :8091/cfg/config.js   vs   curl -i :8092/cfg/config.js │
│   │   → appEnv / ssoClientId 不同，且皆含 Cache-Control: no-store     │
├───┼──────────────────────────────────────────────────────────────────┤
│ 3 │ nginx 層設定不同（命題 1）                                         │
│   │   kubectl -n envtest-dev  exec deploy/fe-test --                 │
│   │     grep backend_upstream /etc/nginx/conf.d/default.conf         │
│   │   kubectl -n envtest-prod exec deploy/fe-test -- （同上）          │
│   │   → proxy 目標不同                                                │
├───┼──────────────────────────────────────────────────────────────────┤
│ 4 │ 靜態資源沒有被 volume 蓋掉                                         │
│   │   kubectl -n envtest-dev exec deploy/fe-test --                  │
│   │     ls /usr/share/nginx/html                                     │
│   │   → 必須仍看得到 index.html 與 assets/                            │
└───┴──────────────────────────────────────────────────────────────────┘
```

### 3-6. 最終驗證：改值不需重新打包，也不需重啟 Pod

這一步才是整份計畫真正要證明的事。方案 D 的目標比 envsubst 路線更高一階：**連 Pod 都不用重啟**。

#### (a) 瀏覽器層：改 `frontend-app-config` → 不需 `rollout restart`

```bash
# 先記下目前的 Pod 名稱，稍後要確認它「沒有」被換掉
kubectl -n envtest-dev get pod -l app=fe-test -o name

kubectl -n envtest-dev patch cm frontend-app-config --type merge \
  -p '{"data":{"config.js":"window.__APP_CONFIG__ = { appEnv: \"dev\", ssoClientId: \"dev-client-CHANGED\" };\n"}}'

# ★ ConfigMap volume 是「最終一致」，有 kubelet sync period + cache TTL 的延遲。
#   請耐心輪詢，不要因為前幾次沒變就判定失敗（最長約 1~2 分鐘）。
for i in $(seq 1 24); do
  echo "--- try $i ---"
  curl -s http://localhost:8091/cfg/config.js
  sleep 5
done
```

通過條件（三項同時成立才算）：

1. 輸出最終變成 `dev-client-CHANGED`
2. **Pod 名稱與 patch 之前完全相同**（`kubectl -n envtest-dev get pod -l app=fe-test -o name`）——證明沒有重啟
3. 全程沒有執行 `docker build`

> 若輸出遲遲不變，第一個要檢查的是 **volumeMount 是不是誤用了 `subPath`**——那會讓自動同步完全失效。

#### (b) nginx 層：改 `frontend-config` → 需要 `rollout restart`

```bash
kubectl -n envtest-dev patch cm frontend-config --type merge \
  -p '{"data":{"BACKEND_URL":"backend-changed.envtest-dev.svc.cluster.local:8080"}}'

kubectl -n envtest-dev exec deploy/fe-test -- grep backend_upstream /etc/nginx/conf.d/default.conf
# → 仍是舊值。這是預期行為：envsubst 只在容器啟動時跑一次

kubectl -n envtest-dev rollout restart deploy/fe-test
kubectl -n envtest-dev rollout status deploy/fe-test
kubectl -n envtest-dev exec deploy/fe-test -- grep backend_upstream /etc/nginx/conf.d/default.conf
# → 變成新值
```

> **`rollout restart` 會刪掉舊 Pod，原本的 port-forward 一定會斷線。** 若還要繼續用 `curl`，必須先 Ctrl-C 再重開 `kubectl port-forward`，否則會是 connection refused，容易被誤判成「機制失效」。

這兩段的對比本身就是重要的交付物：**它讓團隊清楚知道哪一類設定改完要重啟、哪一類不用。**

#### (c) 反向測試：ConfigMap 整份不存在 → 部署階段就失敗

```bash
kubectl -n envtest-prod delete cm frontend-app-config
kubectl -n envtest-prod rollout restart deploy/fe-test
kubectl -n envtest-prod get pod -l app=fe-test
# → 新 Pod 應卡在 ContainerCreating
kubectl -n envtest-prod describe pod -l app=fe-test | tail -20
# → Events 應出現 configmap "frontend-app-config" not found
```

預期：**部署階段就失敗、`rollout status` 不會通過**，而不是讓一個沒有設定的登入頁上線。這驗證了 2-2-2 刻意不加 `optional: true` 的決定。

### 3-7. 清除測試資源

```bash
kubectl delete ns envtest-dev envtest-prod
docker rmi lookgo-frontend:envtest
rm -rf /tmp/cfg-dev /tmp/cfg-prod

# kind 節點內另有一份 image，需分別清除
docker exec look-go-control-plane crictl rmi docker.io/library/lookgo-frontend:envtest
```

### 3-8. 測試路徑選擇

| 測試方式                                        | nginx 層鏈路 | 瀏覽器層鏈路 | 說明                                                                                               |
| ----------------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------- |
| `docker run` + `-e` + `-v`                      | ✅           | ✅           | 走官方 entrypoint templates 機制；bind mount 是 ConfigMap volume 的合理替身                        |
| kind + 2×ConfigMap                              | ✅           | ✅           | 最終驗收方式；**唯一能驗證「自動同步、不需重啟」的環境**（bind mount 無法模擬 kubelet 的同步行為） |
| `docker compose up frontend`（現況）            | ❌           | ❌           | 覆寫了 `command`，`$1` 不是 `nginx`，整批 `/docker-entrypoint.d/` 被跳過；且目前無法啟動（見 1-7） |
| `docker compose up frontend`（套用 1-7 修法後） | ✅           | ⚠️           | nginx 層完全一致；瀏覽器層走 bind mount，內容形式相同但無自動同步語意                              |
| `npm run dev`                                   | ❌           | ⚠️           | 無 nginx；讀 `public/cfg/config.js` 佔位檔，僅驗證前端讀取邏輯正確                                 |
