# 方案 D 的部署指令與驗證作法

> 對應設計文件：`docs/env-changed-by-k8s-plan.md`。
> 對應資源：`k8s/frontend-config.yaml`、`k8s/frontend.yaml`、`lookGo-frontend/nginx.conf`、`lookGo-frontend/index.html`、`lookGo-frontend/public/cfg/config.js`、`docker-compose.yaml`、`local-cfg/config.js`。
>
> **所有指令的執行目錄皆為 `lookGo-infra/`**（前端 build context 因此寫成 `../lookGo-frontend`）。
> 前置條件：Docker Desktop 已啟動，否則 `docker` 與 `kind` 皆無法連線。
>
> **指令環境：本文件全部指令以 Windows cmd.exe 為準**（非 PowerShell、非 Git Bash）。cmd 的單引號、跳脫字元、迴圈語法都跟 bash 不同，規則統一列在 2-0，套用到全文所有指令區塊（標示為 ` ```bat `）。
>
> 標記說明：
>
> - `【已實測】` = 已在本專案 kind 叢集（cluster `look-go`、context `kind-look-go`、namespace `default`）實際執行並記錄輸出。
> - `【待驗收】` = 依官方文件推導，本專案尚未執行。

## 心智模型：兩條鏈路，兩種操作方式

```
  ┌── ConfigMap: frontend-config ────────────────────────────────────┐
  │   DNS_RESOLVER / BACKEND_URL / NGINX_ENVSUBST_FILTER             │
  │        │ envFrom → 容器環境變數                                    │
  │        │ envsubst（★ 只在容器啟動時跑一次）                         │
  │        ▼                                                          │
  │   /etc/nginx/conf.d/default.conf        改了 → 必須 rollout restart│
  └───────────────────────────────────────────────────────────────────┘

  ┌── ConfigMap: frontend-app-config ────────────────────────────────┐
  │   config.js                                                       │
  │        │ volume（★ kubelet 持續同步）                              │
  │        ▼                                                          │
  │   /usr/share/nginx/html/cfg/config.js   改了 → 不需要重啟，等即可   │
  └───────────────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────────────┐
  │   /usr/share/nginx/html/assets/*.js（image 內，打包時凍結）         │
  │   任何 runtime 機制都碰不到 → 禁止使用 import.meta.env.VITE_*       │
  └───────────────────────────────────────────────────────────────────┘
```

---

# 一、容器化部署需要的指令

## 1-1. 部署前的靜態檢查（不動叢集，建議每次都跑）

```bat
:: 確認全庫沒有 import.meta.env.VITE_*（eslint.config.js 已加 no-restricted-syntax 規則擋住）
:: 一旦有人新增就會是 error 而非 warning，CI 會直接失敗
:: 執行目錄為 ../lookGo-frontend
npx eslint src/

:: 確認前端可正常建置，並檢查產出的 index.html 是否含 <script src="/cfg/config.js">
:: 執行目錄為 ../lookGo-frontend
npm run build

:: 三份 manifest 的語法與 schema 檢查（不會送到叢集）
kubectl apply --dry-run=client -f k8s/frontend-config.yaml
kubectl apply --dry-run=client -f k8s/frontend.yaml
kubectl apply --dry-run=client -f k8s/backend.yaml
```

## 1-2. 路徑 A：本機 Docker Compose（快速驗前端行為）

```bat
:: 建置前端映像檔（tag 為 lookgo-frontend:latest，K8s 也共用這顆）
docker compose build frontend

:: 啟動前端容器；nginx.conf 掛到 /etc/nginx/templates/，走官方 entrypoint 的 envsubst
:: local-cfg/ 掛到 /usr/share/nginx/html/cfg，是 K8s ConfigMap volume 的本機替身
docker compose up -d frontend

:: 查看啟動日誌，確認 envsubst 有執行、且沒有 [emerg]
docker compose logs -f frontend

:: 停止前端容器
docker compose stop frontend
```

> ⚠️ `.env` 必須同時有 `DNS_RESOLVER` 與 `BACKEND_URL`。
> `nginx.conf` 裡每一個 `${...}` 只要少一個值，nginx 會 `[emerg] unknown "..." variable` 直接啟動失敗。

## 1-3. 路徑 B：kind / K8s 完整部署（四步，順序不可調換）

```bat
:: ① 建置 image
docker compose build frontend

:: ② 載入 kind 節點
:: Deployment 是 imagePullPolicy: IfNotPresent，不載入的話節點上根本沒有這顆 image
kind load docker-image lookgo-frontend:latest --name look-go

:: ③ 先套用兩份 ConfigMap
:: 必須在 Deployment 之前。volume 的 configMap 刻意不加 optional: true，
:: ConfigMap 不存在時 Pod 會卡在 ContainerCreating（這是刻意設計的大聲失敗）
kubectl apply -f k8s/frontend-config.yaml

:: ④ 再套用 Deployment 與 Service
kubectl apply -f k8s/frontend.yaml

:: ⑤ 等待滾動更新完成（不通過就代表上面某一步有問題，不要往下做驗證）
kubectl rollout status deployment/frontend-deployment
```

【已實測】④ 之後舊 Pod `frontend-deployment-66d9cd8b47-x6qsf` 被換成 `frontend-deployment-7d585bfb5-qh6gd`，`rollout status` 通過。

## 1-4. 日常改設定：兩種情況，指令不同

這是本方案最需要記住的操作差異。**用錯會靜默不一致**（設定改了但服務仍跑舊值，沒有任何錯誤訊息）。

### (a) 改瀏覽器層設定（`appEnv` / `ssoClientId` 等）→ **不需要重啟**

```bat
:: 直接改 k8s/frontend-config.yaml 裡 frontend-app-config 的 config.js 內容，然後：
kubectl apply -f k8s/frontend-config.yaml

:: 之後什麼都不用做。kubelet 會自動把新內容同步進 volume（最終一致，約數十秒）
```

> 不建議用 `kubectl patch`：cmd.exe 對 JSON 內雙引號的跳脫規則（`\"`）比 PowerShell、Git Bash 都更容易寫出「看起來成功、實際內容錯誤」的 patch（詳見 2-0 第 2 條規則）。**一律走宣告式**（改檔案 → `apply`），順便留下 git diff 可 review。

### (b) 改 nginx 層設定（`DNS_RESOLVER` / `BACKEND_URL`）→ **必須重啟**

```bat
kubectl apply -f k8s/frontend-config.yaml

:: 這一步不能省。envsubst 只在容器啟動時跑一次，
:: 不重啟的話 /etc/nginx/conf.d/default.conf 會永遠停在舊值
kubectl rollout restart deployment/frontend-deployment
kubectl rollout status deployment/frontend-deployment
```

### (c) 改前端程式碼或 `nginx.conf` → 必須重新打包

| 變更內容                               | 需要重 build？ | 原因                                                      |
| -------------------------------------- | -------------- | --------------------------------------------------------- |
| 改 `config.js` 裡任何值                | ❌             | 值在 ConfigMap，不在 image                                |
| 改 `DNS_RESOLVER` / `BACKEND_URL` 的值 | ❌             | 同上（但要 restart，見 (b)）                              |
| `src/` 底下任何程式碼                  | ✅             | 會進 `dist/`，`dist/` 在 image 裡                         |
| `nginx.conf` 新增一個 `${...}`         | ✅             | `nginx.conf` 被 `COPY` 進 image；且要同步補 ConfigMap key |
| `appConfig.ts` 新增欄位                | ✅             | 那是程式碼變更，不是設定變更                              |

重 build 時回到 1-3 的 ①→⑤ 完整跑一次。

## 1-5. 清理

```bat
:: 刪除前端 Deployment 與 Service
kubectl delete -f k8s/frontend.yaml

:: 刪除兩份 ConfigMap
kubectl delete -f k8s/frontend-config.yaml

:: 停止本機 compose 容器
docker compose stop frontend

:: kind 節點內另有一份 image，需要另外清（docker rmi 清不到）
docker exec look-go-control-plane crictl rmi docker.io/library/lookgo-frontend:latest
```

---

# 二、驗證作法

驗證分成兩個**互相獨立**的命題，必須分開驗、分開判定：

```
  命題 1（nginx 層）  同一顆 image，只換 frontend-config
                      → 容器內 default.conf 的 proxy 目標不同
                      → 需要 rollout restart

  命題 2（瀏覽器層）  同一顆 image，只換 frontend-app-config
                      → GET /cfg/config.js 的輸出不同
                      → 不需要 rollout restart   ★ 這是方案 D 最關鍵的性質
```

## 2-0. ⚠️ cmd.exe 執行者必讀（本文件所有指令的黃金規則）

cmd.exe **沒有「單引號字串」這個語法**——單引號只是普通字元，不會像 bash 一樣把裡面的空白、`$`、`"` 保護起來。這是本文件最容易踩雷的地方，記住四條規則，全文件已依此改寫：

**規則 1：jsonpath 樣板一律改用 `-o custom-columns`，不要用單引號包 `-o jsonpath='...'`。**
兩種情況都會壞：樣板只要含空白（例如 `{range .items[*]}` 裡 `range` 後面那個空白），cmd 會在該處把整條指令切成兩個參數，後半段被 `kubectl` 誤判成「resource name」，撞上 `-l`/`-A` 就會報 `name cannot be provided when a selector is specified`；就算樣板沒有空白，裡面的 `{"\n"}` 這種帶雙引號的字面值，單引號在 cmd 裡也保護不了雙引號，雙引號會被吃掉、變成不合法的 `{\n}`，報 `unrecognized character in action: U+005C '\'`。`-o custom-columns=NAME:.jsonpath,NAME2:.jsonpath2` 語法本身不含空白也不需要引號，cmd 不會誤切，本文件的驗證指令已全部改用這個寫法：

```bat
kubectl get pod -A -l app=fe-test -o custom-columns=NAMESPACE:.metadata.namespace,IMAGEID:.status.containerStatuses[0].imageID
```

**規則 2：不要用 `kubectl patch` 帶 JSON。**
cmd 的雙引號跳脫（`\"`）規則比 PowerShell 更容易寫出「看起來成功、實際內容是錯的」patch。一律改回宣告式：改 yaml 檔內容 → `kubectl apply -f`（見 3-6 的修正做法）。

**規則 3：不要用 `MSYS_NO_PATHCONV=1` 前綴。**
那是 Git Bash（MSYS2）專用的環境變數寫法，在 cmd 下會被當成「要執行一個叫 `MSYS_NO_PATHCONV=1` 的程式」而直接報錯「不是內部或外部命令」。cmd.exe 本來就不會把 `/usr/share/...` 這種路徑改寫掉，直接下指令即可：

```bat
kubectl exec deployment/frontend-deployment -- cat /usr/share/nginx/html/cfg/config.js
```

**規則 4：`kubectl exec` / `docker exec` 帶 `grep -E 'a|b'` 這種含 `|` 的 pattern，要用雙引號包住。**
`|` 在 cmd 是管線符號，不包起來會被 cmd 自己解讀成「把前一個指令的輸出接給下一個指令」，而不是傳給遠端的 `grep`：

```bat
kubectl exec deployment/frontend-deployment -- grep -E "resolver|backend_upstream" /etc/nginx/conf.d/default.conf
```

**其他常見 bash→cmd 對照**（本文件已依此改寫，供你自己修改指令時參考）：

| bash 寫法                                     | 問題                                                 | cmd 對應寫法                                                                                           |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `for i in $(seq 1 24); do ...; sleep 5; done` | cmd 沒有 `$(...)`、沒有 `do...done`                  | `for /l %i in (1,1,24) do @(... & timeout /t 5 >nul)`（互動輸入用單個 `%i`；存成 `.bat` 檔要改 `%%i`） |
| 行尾 `\` 續行                                 | cmd 的 `\` 只是普通字元，不是續行符                  | 整行寫完，或用行尾 `^` 續行                                                                            |
| `mkdir -p a b`                                | cmd 的 `mkdir` 沒有 `-p`，但本來就會自動建立巢狀目錄 | `mkdir a` `mkdir b`（分開下，或 `mkdir a b`）                                                          |
| `... \| tail -20`                             | cmd 沒有 `tail`                                      | `... \| more`（分頁瀏覽到結尾）或省略，直接看完整輸出                                                  |
| `... \| grep xxx`（在 host 上執行）           | cmd 沒有 `grep`                                      | `... \| findstr xxx`                                                                                   |
| `#` 註解                                      | cmd 的 `#` 會被當成指令去執行而報錯                  | `::` 開頭另起一行                                                                                      |

> 若改用 Git Bash 或 PowerShell，本文件指令需要換回對應語法（單引號在 bash 可用；PowerShell 的引號跳脫規則又不同），不在本文件涵蓋範圍內。

## 2-1. 建置期驗證（部署前）

| 檢查項                   | 指令                   | 通過條件                                                                                 |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------- |
| 沒有 build-time 環境變數 | `npx eslint src/`      | **0 error**（warning 不影響；本專案有 8 個既有的 `react-hooks/exhaustive-deps` warning） |
| 前端可建置               | `npm run build`        | 成功，且 `dist/cfg/config.js` 存在（由 `public/` 複製而來）                              |
| 設定檔有被引入           | 檢視 `dist/index.html` | 含 `<script src="/cfg/config.js"></script>`                                              |

【已實測】`dist/index.html` 的產出是：

```html
<head>
  <script type="module" crossorigin src="/assets/index-BZ1-Lupn.js"></script>
</head>
<body>
  <div id="root"></div>
  <script src="/cfg/config.js"></script>
</body>
```

**module script 被 Vite 提升到 `<head>`、設定檔留在 `<body>`，看起來順序反了，但這是正確的。** `type="module"` 具 defer 語意（文件解析完才執行），classic script 在 parser 走到時同步執行，因此設定一定先載入。**看到這個產出不要誤判成 bug。**

## 2-2. 層級一：純 Docker 驗證（約 2 分鐘，不需叢集）

用 bind mount 模擬 ConfigMap volume，確認 image 本身就支援 runtime 切換。以下指令於 `lookGo-infra/` 執行。

```bat
:: 只打包一次，記下 image ID（後面兩個容器必須是同一顆）
docker build -t lookgo-frontend:envtest --build-arg NPM_RC_FILE=.npmrc-public ../lookGo-frontend
docker inspect --format="{{.Id}}" lookgo-frontend:envtest

:: 準備兩份「ConfigMap 的本機替身」（在目前目錄下建立，%cd% 會展開成目前目錄的絕對路徑）
mkdir cfg-dev
mkdir cfg-prod
echo window.__APP_CONFIG__={"appEnv":"dev","ssoClientId":"dev-client-0000"}; > cfg-dev\config.js
echo window.__APP_CONFIG__={"appEnv":"prod","ssoClientId":"prod-client-9999"}; > cfg-prod\config.js

:: 同一顆 image 跑兩份，差異只在 -e（nginx 層）與 -v（瀏覽器層）
docker run -d --name fe-dev  -p 8091:80 -e DNS_RESOLVER=8.8.8.8 -e BACKEND_URL=backend-dev:8080 -v %cd%\cfg-dev:/usr/share/nginx/html/cfg:ro lookgo-frontend:envtest

docker run -d --name fe-prod -p 8092:80 -e DNS_RESOLVER=8.8.8.8 -e BACKEND_URL=backend-prod:8080 -v %cd%\cfg-prod:/usr/share/nginx/html/cfg:ro lookgo-frontend:envtest

:: 命題 2：瀏覽器層（順便確認 Cache-Control: no-store 有生效）
curl -i http://localhost:8091/cfg/config.js
curl -i http://localhost:8092/cfg/config.js

:: 命題 1：nginx 層（證明 envsubst 在啟動時執行過）
docker exec fe-dev  grep backend_upstream /etc/nginx/conf.d/default.conf
docker exec fe-prod grep backend_upstream /etc/nginx/conf.d/default.conf

:: 確認 volume 只蓋掉 /cfg，沒有把 dist 蓋掉
docker exec fe-dev ls /usr/share/nginx/html

:: 清理
docker rm -f fe-dev fe-prod
```

通過條件：

- 兩組 `/cfg/config.js` 的 `appEnv` / `ssoClientId` 完全不同，且回應含 `Cache-Control: no-store`
- 兩組 `backend_upstream` 不同
- `ls` 仍看得到 `index.html` 與 `assets/`

## 2-3. 反向測試：親眼看到兩種失效模式（建議一併做）

這兩項的價值在於**讓團隊知道「設定漏了」在兩條鏈路上的後果天差地遠**。承接 2-2，`cfg-dev` 目錄需已存在。

**(a) nginx 層變數缺漏 → 容器起不來（全站中斷）**

```bat
:: 刻意不給 BACKEND_URL
docker run -d --name fe-broken -p 8093:80 -e DNS_RESOLVER=8.8.8.8 -v %cd%\cfg-dev:/usr/share/nginx/html/cfg:ro lookgo-frontend:envtest

docker logs fe-broken
:: 應看到 [emerg] unknown "backend_url" variable

docker ps -a --filter name=fe-broken
:: 應為 Exited，不是 Up

docker rm -f fe-broken
```

**(b) 瀏覽器層設定缺漏 → 前端降級，服務不中斷**

```bat
:: 不掛 volume，模擬 config.js 不存在
docker run -d --name fe-nocfg -p 8094:80 -e DNS_RESOLVER=8.8.8.8 -e BACKEND_URL=backend-dev:8080 lookgo-frontend:envtest

curl -i http://localhost:8094/cfg/config.js
:: 應為 image 內建的佔位值（public/cfg/config.js）

curl -sI http://localhost:8094/
:: 應為 200，網站仍可用

docker rm -f fe-nocfg
```

> 同樣是「設定漏了」，(a) 全站中斷、(b) 只是降級。這正是方案 D 把觸發點固定在 2 個的理由。

## 2-4. 層級二：現行叢集的部署後驗證（六項）

以下針對 1-3 部署完成後的 `frontend-deployment` 執行。cmd.exe 不需要 `MSYS_NO_PATHCONV=1` 前綴（見 2-0 規則 3）。

```bat
:: ① 容器內的 config.js 來自 ConfigMap，不是 image 內建的佔位檔
kubectl exec deployment/frontend-deployment -- cat /usr/share/nginx/html/cfg/config.js

:: ② volume 沒有把 dist 蓋掉
kubectl exec deployment/frontend-deployment -- ls /usr/share/nginx/html

:: ③ envsubst 有跑過，nginx 層的值來自 ConfigMap（pattern 含 | ，要用雙引號包住，見 2-0 規則 4）
kubectl exec deployment/frontend-deployment -- grep -E "resolver|backend_upstream" /etc/nginx/conf.d/default.conf

:: ④ HTTP 回應正確（需另開一個 cmd 視窗執行 port-forward）
kubectl port-forward svc/frontend-service 8081:80
curl -i http://localhost:8081/cfg/config.js

:: ⑤ 首頁確實有引入設定檔（cmd 沒有 grep，改用內建的 findstr）
curl -s http://localhost:8081/ | findstr cfg/config.js
```

【已實測】結果：

| #   | 實際輸出                                                                                                                                | 判定              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| ①   | `appEnv: "dev"`、`ssoClientId: "dev-client-placeholder"`                                                                                | ✅ 來自 ConfigMap |
| ②   | `50x.html assets cfg favicon.svg icons.svg index.html`                                                                                  | ✅ dist 完整      |
| ③   | `resolver kube-dns.kube-system.svc.cluster.local valid=10s;`<br>`set $backend_upstream backend-service.default.svc.cluster.local:8080;` | ✅ 兩處都被替換   |
| ④   | `200`、`Content-Type: application/javascript`、`Cache-Control: no-store`                                                                | ✅                |
| ⑤   | `<script src="/cfg/config.js"></script>`                                                                                                | ✅                |

## 2-5. 關鍵驗證：改瀏覽器層設定，Pod 不重啟（命題 2）

**這一項才是整份計畫真正要證明的事**，前面各項都只是前置條件。

```bat
:: 先記下目前的 Pod 名稱與啟動時間，稍後要確認它「沒有」被換掉（jsonpath 改用 custom-columns，見 2-0 規則 1）
kubectl get pod -l app=frontend -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,STARTED:.status.containerStatuses[0].state.running.startedAt

:: 改 k8s/frontend-config.yaml 裡 frontend-app-config 的 appEnv 值（例如改成 dev-CHANGED），然後：
kubectl apply -f k8s/frontend-config.yaml

:: ConfigMap volume 是「最終一致」，有 kubelet sync period + cache TTL 的延遲。
:: 耐心輪詢，不要因為前幾次沒變就判定失敗（最長約 1~2 分鐘）。
:: 直接在 cmd 提示字元互動輸入時用單個 %i；若存成 .bat 檔要改成 %%i
for /l %i in (1,1,24) do @(echo --- try %i --- & kubectl exec deployment/frontend-deployment -- grep appEnv /usr/share/nginx/html/cfg/config.js & timeout /t 5 >nul)

:: 驗完記得把值改回來並重新 apply
kubectl apply -f k8s/frontend-config.yaml
```

通過條件（**三項同時成立**才算）：

1. 輸出最終變成新值
2. Pod 名稱、`restartCount`、`startedAt` 與 apply 之前**完全相同**
3. 全程沒有執行 `docker build`、沒有執行 `rollout restart`

【已實測】結果：

```
apply 時間        14:51:48Z（UTC）＝ 22:51:48（本機 UTC+8）
try1  22:52:14   appEnv: "dev"
try3  22:52:25   appEnv: "dev"
try4  22:52:30   appEnv: "dev-CHANGED"     ← 42 秒後同步完成

Pod 名稱      frontend-deployment-7d585bfb5-qh6gd（前後相同）
restartCount  0
startedAt     2026-08-05T14:48:40Z（早於 apply 時間 → 確實沒有重啟）
```

> 若輸出遲遲不變，**第一個要檢查的是 volumeMount 是不是誤用了 `subPath`** —— K8s 明確規定以 `subPath` 掛載的 ConfigMap 不會收到更新，那會讓自動同步完全失效。

## 2-6. 對照驗證：改 nginx 層設定，必須重啟（命題 1）

【待驗收】本專案尚未執行，但這是理解 1-4 兩種操作差異的關鍵對照。

```bat
:: 改 k8s/frontend-config.yaml 裡 frontend-config 的 BACKEND_URL，然後：
kubectl apply -f k8s/frontend-config.yaml

kubectl exec deployment/frontend-deployment -- grep backend_upstream /etc/nginx/conf.d/default.conf
:: 仍是舊值。這是預期行為，不是 bug：envsubst 只在容器啟動時跑一次

kubectl rollout restart deployment/frontend-deployment
kubectl rollout status deployment/frontend-deployment

kubectl exec deployment/frontend-deployment -- grep backend_upstream /etc/nginx/conf.d/default.conf
:: 變成新值
```

> `rollout restart` 會刪掉舊 Pod，**原本的 `port-forward` 一定會斷線**。要繼續用 `curl` 必須先 Ctrl-C 再重開，否則會是 connection refused，很容易被誤判成「機制失效」。

## 2-7. 反向測試：ConfigMap 整份不存在 → 部署階段就失敗

驗證「刻意不加 `optional: true`」這個決定是否生效。**建議在測試 namespace 做，不要在正在用的環境做。**

```bat
kubectl delete cm frontend-app-config
kubectl rollout restart deployment/frontend-deployment
kubectl get pod -l app=frontend
:: 新 Pod 應卡在 ContainerCreating

kubectl describe pod -l app=frontend | more
:: cmd 沒有 tail（見 2-0 對照表），改用 more 往下翻頁到結尾看 Events 那段
:: → Events 應出現 configmap "frontend-app-config" not found

:: 復原
kubectl apply -f k8s/frontend-config.yaml
```

預期：**`rollout status` 不會通過、部署階段就失敗**，而不是讓一個沒有設定的前端上線。

## 2-8. 跨環境驗收：證明「只打包一次」

【待驗收】本專案目前只有一個環境（`default` namespace），這項尚未執行。

要真正證明「三環境同一顆 image」，必須比對 **`imageID`（digest）**，不能比對 `.spec.containers[].image`（tag）——tag 可以被覆寫，相同的 tag 不代表相同的內容。

```bat
kubectl get pod -A -l app=frontend -o custom-columns=NAMESPACE:.metadata.namespace,IMAGEID:.status.containerStatuses[0].imageID
:: 各環境的 sha256 必須一模一樣
```

> ⚠️ **目前的 `image: lookgo-frontend:latest` 讓這項驗收無法成立。**
> 機制上支援一次打包多環境部署，但 `latest` 是可變動的別名，無法證明 uat 跑的就是 dev 測過的那顆。
> 開第二個環境之前，應先依 plan 文件檢查清單 #13 改為 commit SHA 的 immutable tag。

## 2-9. 各測試路徑能驗到什麼

| 測試方式                          | nginx 層 | 瀏覽器層 | 自動同步 | 說明                                                                     |
| --------------------------------- | -------- | -------- | -------- | ------------------------------------------------------------------------ |
| `docker run` + `-e` + `-v`（2-2） | ✅       | ✅       | ❌       | 走官方 entrypoint；bind mount 是 ConfigMap volume 的合理替身             |
| kind + 2×ConfigMap（2-4、2-5）    | ✅       | ✅       | ✅       | 最終驗收方式；**唯一能驗證「不需重啟」的環境**                           |
| `docker compose up frontend`      | ✅       | ⚠️       | ❌       | nginx 層鏈路與 K8s 完全一致；瀏覽器層走 bind mount，形式相同但無同步語意 |
| `npm run dev`                     | ❌       | ⚠️       | ❌       | 無 nginx；讀 `public/cfg/config.js` 佔位檔，只驗證前端讀取邏輯           |

---

# 三、SSO 全新值跨環境動態切換測試

> 目的：驗證「只打包一次，SSO 相關設定在 dev / uat / prod 三環境各自動態生效」，且全程使用**沒在前兩節出現過的全新測試值**，避免與既有驗證紀錄（`dev-client-placeholder`、`dev-client-0000`、`dev-client-CHANGED` 等）混淆。
> 做法：在同一個 kind 叢集內開三個 namespace（`sso-dev` / `sso-uat` / `sso-prod`）模擬三環境，共用同一顆 image digest，只有兩份 ConfigMap 的值不同。依 2-9 的結論，這是唯一能同時驗到「同一顆 image」「值真的不同」「改值不需重建」三件事的測試方式。
> 標記：本節尚未執行，全部標【待驗收】。指令一律為 cmd.exe 語法（見 2-0）。

## 3-1. 定義三環境的全新 SSO 測試值

值刻意帶入日期字串，避免跟前兩節已出現過的測試值混淆：

| 環境 | namespace  | appEnv | ssoClientId（全新值） | BACKEND_URL（nginx 層，順便證明兩條鏈路互相獨立） |
| ---- | ---------- | ------ | --------------------- | ------------------------------------------------- |
| dev  | `sso-dev`  | `dev`  | `sso-dev-0806-alpha`  | `backend-service.sso-dev.svc.cluster.local:8080`  |
| uat  | `sso-uat`  | `uat`  | `sso-uat-0806-beta`   | `backend-service.sso-uat.svc.cluster.local:8080`  |
| prod | `sso-prod` | `prod` | `sso-prod-0806-gamma` | `backend-service.sso-prod.svc.cluster.local:8080` |

若已有真實 SSO client id 可直接代入本表；還沒有的話，先用這組合成值跑通機制，之後只需要換 ConfigMap 的值，image 與程式碼都不動。

## 3-2. 只 build 一次 image

```bat
:: 執行目錄 lookGo-infra/
docker build -t lookgo-frontend:ssotest --build-arg NPM_RC_FILE=.npmrc-public ../lookGo-frontend
docker inspect --format="{{.Id}}" lookgo-frontend:ssotest
:: 記下 sha256，3-5 要用它比對三環境是否一致
kind load docker-image lookgo-frontend:ssotest --name look-go
```

## 3-3. 準備三份 namespace 的測試 manifest

三份結構完全相同（Namespace + 2×ConfigMap + Deployment + Service），只有 namespace 名稱與兩份 ConfigMap 的值不同；三份 Deployment 的 `image:` 必須是同一字串 `lookgo-frontend:ssotest`。存成 `k8s/sso-switch-test.yaml`，驗完即刪，不進版控。

> 【已實測】曾誤把檔案只寫 `sso-dev` 一份就直接跑 3-4，`kubectl apply` 只會建出檔案裡實際有的資源——結果只有 `sso-dev` 建成功，`kubectl -n sso-uat rollout status` / `sso-prod` 回 `Error from server (NotFound): namespaces "sso-uat" not found`。**這是預期行為，不是指令錯誤**：`kubectl apply -f` 不會自動把註解「仿照上面再寫兩份」變成實際資源，三份 namespace 必須都真的寫進檔案。以下為三份的完整內容。

```yaml
# sso-switch-test.yaml（測試用，驗證完即刪）
apiVersion: v1
kind: Namespace
metadata:
  name: sso-dev
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: sso-dev
data:
  DNS_RESOLVER: 'kube-dns.kube-system.svc.cluster.local'
  BACKEND_URL: 'backend-service.sso-dev.svc.cluster.local:8080'
  NGINX_ENVSUBST_FILTER: '^(DNS_RESOLVER|BACKEND_URL)$'
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-app-config
  namespace: sso-dev
data:
  config.js: |
    window.__APP_CONFIG__ = { appEnv: "dev", ssoClientId: "sso-dev-0806-alpha" };
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fe-test
  namespace: sso-dev
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
          image: docker.io/library/lookgo-frontend:ssotest # 三個 namespace 必須完全相同
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
apiVersion: v1
kind: Service
metadata:
  name: fe-test
  namespace: sso-dev
spec:
  type: ClusterIP
  selector:
    app: fe-test
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: v1
kind: Namespace
metadata:
  name: sso-uat
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: sso-uat
data:
  DNS_RESOLVER: 'kube-dns.kube-system.svc.cluster.local'
  BACKEND_URL: 'backend-service.sso-uat.svc.cluster.local:8080'
  NGINX_ENVSUBST_FILTER: '^(DNS_RESOLVER|BACKEND_URL)$'
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-app-config
  namespace: sso-uat
data:
  config.js: |
    window.__APP_CONFIG__ = { appEnv: "uat", ssoClientId: "sso-uat-0806-beta" };
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fe-test
  namespace: sso-uat
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
          image: docker.io/library/lookgo-frontend:ssotest # 三個 namespace 必須完全相同
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
apiVersion: v1
kind: Service
metadata:
  name: fe-test
  namespace: sso-uat
spec:
  type: ClusterIP
  selector:
    app: fe-test
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: v1
kind: Namespace
metadata:
  name: sso-prod
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: sso-prod
data:
  DNS_RESOLVER: 'kube-dns.kube-system.svc.cluster.local'
  BACKEND_URL: 'backend-service.sso-prod.svc.cluster.local:8080'
  NGINX_ENVSUBST_FILTER: '^(DNS_RESOLVER|BACKEND_URL)$'
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-app-config
  namespace: sso-prod
data:
  config.js: |
    window.__APP_CONFIG__ = { appEnv: "prod", ssoClientId: "sso-prod-0806-gamma" };
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fe-test
  namespace: sso-prod
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
          image: docker.io/library/lookgo-frontend:ssotest # 三個 namespace 必須完全相同
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
apiVersion: v1
kind: Service
metadata:
  name: fe-test
  namespace: sso-prod
spec:
  type: ClusterIP
  selector:
    app: fe-test
  ports:
    - port: 80
      targetPort: 80
```

> 未加 `initContainer` 與 probe：`wait-for-backend` 在沒有 backend 的測試 namespace 會卡在 `Init`，與本次要驗證的事無關（同 plan.md 3-4 的作法）。
> 未加 `optional: true`：ConfigMap 缺漏時應讓 Pod 卡在部署階段（見 3-7 反向測試同一邏輯，見 2-7）。

## 3-4. 部署三環境

```bat
kubectl apply -f sso-switch-test.yaml
kubectl -n sso-dev  rollout status deploy/fe-test
kubectl -n sso-uat  rollout status deploy/fe-test
kubectl -n sso-prod rollout status deploy/fe-test
```

port-forward 需要各自佔用一個終端機前景執行，開三個獨立的 cmd 視窗分別下：

```bat
kubectl -n sso-dev  port-forward svc/fe-test 8095:80
```

```bat
kubectl -n sso-uat  port-forward svc/fe-test 8096:80
```

```bat
kubectl -n sso-prod port-forward svc/fe-test 8097:80
```

## 3-5. 驗收（四項全過才算成立，對應 plan.md 3-5）

【已實測】四項全過，指令與實測輸出如下（cmd.exe 執行，已套用 2-0 的 custom-columns 寫法）。

### (1) 驗證「三環境跑在同一顆 Image Digest」

- 檢查三個 Namespace 下 Pod 所使用的容器 Image Digest (sha256) 完全相同

```bat
kubectl get pod -A -l app=fe-test -o custom-columns=NAMESPACE:.metadata.namespace,IMAGEID:.status.containerStatuses[0].imageID
```

【已實測】結果：

```
sso-dev     sha256:881507a68d017c3554802910c46a98b37378df7c119ceb77ef544ae57c6ebf03
sso-prod    sha256:881507a68d017c3554802910c46a98b37378df7c119ceb77ef544ae57c6ebf03
sso-uat     sha256:881507a68d017c3554802910c46a98b37378df7c119ceb77ef544ae57c6ebf03
```

→ 三行 sha256 一致 ✅

### (2) 驗證「瀏覽器層 SSO 設定在三環境各自不同」

- 對三個通訊埠發送 HTTP 請求，檢查 /cfg/config.js 產出的 ssoClientId

```bat
curl -i http://localhost:8095/cfg/config.js
curl -i http://localhost:8096/cfg/config.js
curl -i http://localhost:8097/cfg/config.js
```

【已實測】結果：

```
window.__APP_CONFIG__ = { appEnv: "dev", ssoClientId: "sso-dev-0806-alpha" };
window.__APP_CONFIG__ = { appEnv: "uat", ssoClientId: "sso-uat-0806-beta" };
window.__APP_CONFIG__ = { appEnv: "prod", ssoClientId: "sso-prod-0806-gamma" };
```

→ ssoClientId 三者互不相同 ✅

### (3) 驗證「Nginx 層設定在三環境各自不同（獨立性驗證）」

- 檢查容器內 `/etc/nginx/conf.d/default.conf` 替換後的代理目標是否不同

```bat
kubectl -n sso-dev  exec deploy/fe-test -- grep backend_upstream /etc/nginx/conf.d/default.conf
kubectl -n sso-uat  exec deploy/fe-test -- grep backend_upstream /etc/nginx/conf.d/default.conf
kubectl -n sso-prod exec deploy/fe-test -- grep backend_upstream /etc/nginx/conf.d/default.conf
```

→ 三個 proxy 目標不同（分別指向各 namespace 的 backend-service）✅

### (4) 驗證「靜態資源沒有被 volume 蓋掉」

- 確認 `/usr/share/nginx/html` 下原有的前端資源仍完整保留

```bat
kubectl -n sso-dev exec deploy/fe-test -- ls /usr/share/nginx/html
```

【已實測】結果：

```
50x.html
assets
cfg
favicon.svg
icons.svg
index.html
```

→ `index.html` 與 `assets/` 都在，dist 沒被 volume 蓋掉 ✅

## 3-6. 動態切換測試：換一組更新的全新值，不重建、不重啟

任選一個環境（例如 `sso-dev`）驗證「改 SSO 值不需要重新打包也不需要重啟 Pod」——這是「動態切換」四個字真正要證明的事。**不要用 `kubectl patch`**（見 2-0 規則 2），一律改檔案內容再 `apply`：

```bat
:: 先記下 Pod 名稱、重啟次數、啟動時間，稍後要確認它們「沒有」變
kubectl -n sso-dev get pod -l app=fe-test -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,STARTED:.status.containerStatuses[0].state.running.startedAt
```

<!-- NAME                       RESTARTS   STARTED
fe-test-5d78dbf76f-xw7p5   0          2026-08-05T23:31:11Z -->

打開 `k8s\sso-switch-test.yaml`，找到 `namespace: sso-dev` 底下 `frontend-app-config` 的 `config.js`，把 `ssoClientId` 改成 `sso-dev-0806-alpha-v2`，存檔後：

```bat
kubectl apply -f sso-switch-test.yaml
```

```bat
:: ConfigMap volume 是最終一致，耐心輪詢（最長約 1~2 分鐘），不要因前幾次沒變就判定失敗
:: 直接在 cmd 提示字元互動輸入時用單個 %i；存成 .bat 檔要改成 %%i
for /l %i in (1,1,24) do @(echo --- try %i --- & curl -s http://localhost:8095/cfg/config.js & timeout /t 5 >nul)
```

<!-- --- try 11 ---
window.__APP_CONFIG__ = { appEnv: "dev", ssoClientId: "sso-dev-0806-alpha-v2" }; -->

通過條件（三項同時成立才算）：

1. 輸出最終變成 `sso-dev-0806-alpha-v2`
2. Pod 名稱、`restartCount`、`startedAt` 與 apply 之前**完全相同**

```shell
kubectl -n sso-dev get pod -l app=fe-test -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,STARTED:.status.containerStatuses[0].state.running.startedAt
```

<!-- NAME                       RESTARTS   STARTED
fe-test-5d78dbf76f-xw7p5   0          2026-08-05T23:31:11Z -->

3. 全程沒有執行 `docker build`、沒有執行 `rollout restart`

> 若輸出遲遲不變，第一個要檢查的是 volumeMount 是不是誤用了 `subPath`（見 2-5 附註）。

## 3-7. 清理

```bat
kubectl delete ns sso-dev sso-uat sso-prod
docker rmi lookgo-frontend:ssotest
docker exec look-go-control-plane crictl rmi docker.io/library/lookgo-frontend:ssotest
del k8s\sso-switch-test.yaml
```

## 3-8. 心智模型對比總結：如何管理變數達成「打包一次、多環境動態切換 SSO」

依 3-1~3-7 的實測結果整理，取代最初只憑推導寫的心智模型（心智模型章節），補上兩層各自的完整行為與本次實測證據。

### 更新後的心智模型對比表

| 對比項目 | Nginx 層 | 瀏覽器層 |
| --- | --- | --- |
| 變數例子 | `DNS_RESOLVER`、`BACKEND_URL` | `ssoClientId`、`appEnv` |
| ConfigMap | `frontend-config` | `frontend-app-config` |
| 送達方式 | `envFrom` → 容器環境變數 | `volumeMount` → 檔案（掛**目錄** `/usr/share/nginx/html/cfg`，不可用 `subPath`） |
| 誰在消費這個值 | nginx entrypoint 的 `20-envsubst-on-templates.sh`，**容器啟動當下**跑一次 | 瀏覽器：`<script src="/cfg/config.js">` 是 classic script，在 parser 走到時同步執行，早於 `type="module"` 的 SPA 主程式，把值寫進 `window.__APP_CONFIG__` |
| 產出位置 | `/etc/nginx/conf.d/default.conf`（被解析、渲染進設定檔） | `/usr/share/nginx/html/cfg/config.js`（純靜態檔，nginx 原樣吐出，不解析內容） |
| 改值後怎麼生效 | 改 ConfigMap 還不夠，**必須 `kubectl rollout restart`**（envsubst 只在啟動時跑一次） | 改 ConfigMap 後**什麼都不用做**，kubelet 自動同步 volume（最終一致） |
| 本次實測延遲 | 需手動觸發才變（2-6 待驗收） | 2-5 節：42 秒後同步完成；3-6 節：第 11 次輪詢（約 55 秒）同步完成 |
| 設定漏一個 key 的後果 | `[emerg] unknown "xxx" variable` → **CrashLoopBackOff，全站中斷** | 欄位讀到 `undefined`，`appConfig.ts` 用預設值降級，**服務不中斷** |
| 本次 SSO 測試證據 | `grep backend_upstream` 三個 namespace（`sso-dev`/`sso-uat`/`sso-prod`）proxy 目標各自不同 | `curl /cfg/config.js` 三個 namespace 的 `ssoClientId` 各自不同（`sso-dev-0806-alpha` / `-beta` / `-gamma`）；改成 `-v2` 後 Pod 名稱、`restartCount`、`startedAt` 三者皆未變，證明真的沒重啟 |
| 同一顆 image 的證據 | — | `kubectl get pod -A -o custom-columns=...IMAGEID` 三個 namespace 回傳的 `imageID` 完全一致（`sha256:881507a6...`），證明是同一顆 image 只是設定不同 |

### 如何管理變數，達成「打包一次、多環境動態切換 SSO」

核心原則：**分流依據是「誰消費這個值」，不是「哪個環境」。**

1. **鐵律：SSO 相關值絕對不能用 `import.meta.env.VITE_*`。** Vite 在 `npm run build` 那一刻就把值字面 inline 進 `dist/*.js`，之後任何 runtime 機制都碰不到它——一旦這樣寫，「一次打包多環境」就直接破功。本專案的 `appConfig.ts` 改讀 `window.__APP_CONFIG__`，就是為了繞開這個限制。

2. **兩份 ConfigMap，兩條路，兩種 SOP：**
   - nginx 自己要用的（`DNS_RESOLVER`、`BACKEND_URL`）→ `frontend-config` → `envFrom` → entrypoint 內建的 envsubst，**啟動時寫死**進 nginx 設定檔 → 改值要 `rollout restart`。
   - 瀏覽器要用的（`ssoClientId`、`appEnv`）→ `frontend-app-config` → volume 掛成 `/cfg/config.js` → nginx 純粹當靜態檔吐出去 → kubelet 持續同步 → 改值**不需要重啟**。

3. **image 只打包一次，環境差異全部收斂到 ConfigMap，不收斂到 image：** 三個 namespace 的 Deployment 用的 `image: docker.io/library/lookgo-frontend:ssotest` 是同一個字串，且已用 imageID digest 驗證三邊真的是同一顆 image；不同的只有各自 `frontend-app-config` 裡的 `ssoClientId` 值。

4. **實際換 SSO 值的操作 SOP**（對應 1-4a、3-6）：
   a. 改該環境的 `frontend-app-config` ConfigMap（yaml 裡 `config.js` 的內容）
   b. `kubectl apply -f`
   c. 什麼都不用做，等 kubelet 同步（本次實測約 40~55 秒）；`config.js` 帶 `Cache-Control: no-store`，保證瀏覽器下次載入一定重抓
   d. **不要用 `kubectl patch`**——cmd.exe 的 JSON 引號跳脫地雷太多，一律宣告式 `apply`，順便留 git diff 可 review

5. **若同時要換 nginx 層的值**（例如 `BACKEND_URL`），走的是另一條 SOP：`apply` 之後還要多一步 `kubectl rollout restart`，因為 envsubst 只在容器啟動時跑一次——這正是 1-4 特別強調「用錯會靜默不一致」的地方。

6. **正式開三個真環境時**（而非本節模擬用的三個 namespace），建議依附錄已知問題 #4 導入 kustomize overlay：一份 base + 三份 overlay 分別管 dev/uat/prod 的 ConfigMap 值，避免三份 yaml 手動維護、容易漏改；同時要處理附錄 #1（`image:latest` 改成 commit SHA 的 immutable tag），否則正式環境無法像本節一樣用 imageID digest 證明「三環境真的是同一顆 image」。

---

## 附錄：已知未處理項目

| #   | 項目                                                    | 影響                                                                      | 對應 plan 檢查清單 |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| 1   | `image: ...:latest` 非 immutable tag                    | 2-8 的跨環境驗收無法成立、無法 rollback                                   | #13                |
| 2   | `nginx.conf` 註解裡的 `$BACKEND_URL` 會被 envsubst 替換 | 純外觀問題（產生的 `default.conf` 註解會變成實際值），需重 build 才會修正 | —                  |
| 3   | 尚無 CI 檢查模板 `${...}` 與 ConfigMap keys 的差集      | 漏 key 會在部署時才炸（CrashLoopBackOff）                                 | #12                |
| 4   | 尚未導入 kustomize overlay                              | 多環境時三份 yaml 要手動維護，容易漏改                                    | #8                 |
