# lookGo k8s 配置審查報告

> 審查範圍：`k8s/` 目錄下全部 manifests 與 Dockerfile
> 審查基準：企業級中小型專案、前後端分離架構的 Kubernetes 主流實踐
> 日期：2026-07-16

## 總評

目前的配置屬於「本機開發叢集（Minikube / Docker Desktop）可跑」的等級，服務拆分、Secret 引用、健康檢查等基本骨架都有做對。但距離可上線的企業級部署，有幾類問題必須處理，依嚴重性排序：

| 優先級 | 問題 | 影響 |
|--------|------|------|
| 🔴 高 | 真實憑證（TDX client id/secret 等）以 base64 直接進版控 | 安全事故 |
| 🔴 高 | 所有容器缺少 resources requests/limits | 排程不穩、可能被 OOM 波及整台節點 |
| 🔴 高 | 鏡像全用 `latest` + `IfNotPresent` | 無法回滾、無法追蹤版本、更新不生效 |
| 🟠 中 | 有狀態服務（SQL Server / Redis）用 Deployment 而非 StatefulSet，且未設 `Recreate` 策略 | 滾動更新時新舊 Pod 搶同一顆 RWO 磁碟而卡死 |
| 🟠 中 | 缺 Ingress，前端只有 ClusterIP | 外部流量無入口 |
| 🟠 中 | initContainer 用 `nc` 等待依賴服務 | 反模式，readiness probe 已足夠 |
| 🟡 低 | 缺 namespace、缺標準 labels、命名錯字、無用的環境變數等 | 維運品質 |

---

## 🔴 高優先：必須調整

### 1. 憑證外洩：Secret YAML 連同真實憑證進了 Git

**現況**：`sqlserver-secret.yaml`、`redis-secret.yaml`、`jwt-secret.yaml`、`backend-secret.yaml` 全部以 base64 寫死在版控中。base64 **不是加密**，任何能讀 repo 的人一行指令就能還原。其中 `backend-secret.yaml` 內含 **TDX 平台的真實 client id 與 client secret**，這已經是實際的憑證外洩，不只是壞習慣。

**必要性**：Secret 進版控是企業環境最常見的資安稽核紅線。一旦 repo 被 fork、clone 或公開，所有資料庫密碼、JWT 簽章金鑰、第三方 API 憑證同時失守，且 Git 歷史會永久保留（即使之後刪檔）。

**建議做法**（中小型專案由簡到繁擇一）：
1. 立即**輪換（rotate）所有已提交的憑證**——尤其 TDX client secret 與 JWT secret，刪檔不夠，歷史紀錄仍在。
2. 把 `*-secret.yaml` 加入 `.gitignore`，改為提交 `*-secret.yaml.example`（只有 key、沒有值）。
3. 主流方案擇一：
   - **Sealed Secrets**（Bitnami）：加密後的 Secret 可以安全進版控，最適合中小型 GitOps 流程。
   - **External Secrets Operator** + 雲端 Secret Manager（AWS/GCP/Azure）：企業常見標配。
   - 最低限度：CI/CD 部署時用 `kubectl create secret ... --from-literal` 從 pipeline 變數注入。

### 2. 缺少 resources requests / limits

**現況**：四個 Deployment 的容器（含 initContainers）全部沒有 `resources` 區塊。

**必要性**：
- 沒有 `requests`，scheduler 無法合理分配 Pod，節點容易超賣；這些 Pod 的 QoS 等級是 `BestEffort`，**節點記憶體吃緊時會最先被驅逐**——資料庫被驅逐等於服務中斷。
- 沒有 `limits`，SQL Server（出了名吃記憶體）可能吃光整台節點，把其他服務一起拖垮。
- 企業叢集通常會用 `ResourceQuota`/`LimitRange` 強制要求，沒寫 requests 的 Pod 直接無法部署。

**建議做法**（數值依實測調整，先給保守起點）：

```yaml
# backend（Spring Boot）
resources:
  requests: { cpu: 250m, memory: 512Mi }
  limits:   { memory: 1Gi }

# frontend（nginx 靜態站）
resources:
  requests: { cpu: 50m, memory: 64Mi }
  limits:   { memory: 128Mi }

# sqlserver（MSSQL 官方最低需求 2Gi）
resources:
  requests: { cpu: 500m, memory: 2Gi }
  limits:   { memory: 3Gi }

# redis
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits:   { memory: 256Mi }
```

> 主流實踐傾向設定 memory limit、不設或放寬 CPU limit（CPU 是可壓縮資源，limit 過低只會造成 throttling）。另外 Spring Boot 建議同時設定 JVM 參數（如 `-XX:MaxRAMPercentage=75`）讓 heap 跟著容器記憶體走。

### 3. 鏡像標籤 `latest` + `IfNotPresent`

**現況**：四個服務鏡像都是 `lookgo-xxx:latest`，且 `imagePullPolicy: IfNotPresent`。

**必要性**：
- `latest` 無法辨識目前線上跑的是哪一版程式碼，**出事無法回滾到已知良好版本**。
- `IfNotPresent` + `latest` 的組合：節點上已有同名鏡像就不會拉新的，導致「明明推了新版卻沒生效」的經典問題；反過來改成 `Always` 又會讓每次 Pod 重啟都依賴 registry。
- Deployment 的滾動更新靠 pod template 變更觸發——tag 永遠是 `latest` 時 `kubectl apply` 根本不會觸發更新。

**建議做法**：CI 以 **git SHA 或語意化版本**打 tag（如 `lookgo-backend:1.4.2` 或 `lookgo-backend:63f9e19`），manifest 中引用明確版本。`docker.io/library/` 前綴是 Docker 官方鏡像的保留命名空間，自建鏡像應推到自己的 registry（Docker Hub 帳號、GHCR、Harbor 等）並改用對應路徑。

---

## 🟠 中優先：架構層面應調整

### 4. SQL Server / Redis 應改用 StatefulSet，或至少設定 `strategy: Recreate`

**現況**：兩個有狀態服務都用 Deployment，未指定更新策略（預設 `RollingUpdate`），掛載 `ReadWriteOnce` 的 PVC。

**必要性**：`RollingUpdate` 會先啟動新 Pod 再終止舊 Pod。新舊 Pod 同時存在時會**爭奪同一顆 RWO volume**：若新 Pod 被排到不同節點，volume attach 失敗直接卡在 `ContainerCreating`；即使同節點，兩個 SQL Server 進程同時開同一份資料檔也有損毀風險。

**建議做法**：
- 最小修正：兩個 Deployment 加上 `spec.strategy.type: Recreate`。
- 主流做法：改用 **StatefulSet**（穩定網路識別、`volumeClaimTemplates`、有序啟停），這是資料庫類 workload 的標準寫法。
- 企業實務上更常見的選擇：**資料庫不進叢集**，改用雲端受管服務（Azure SQL、AWS RDS、ElastiCache）。中小型專案自管資料庫要自己扛備份、HA、升級，通常不划算。

### 5. 缺少 Ingress（外部流量入口）

**現況**：`frontend-service` 是 `ClusterIP`，叢集外根本連不到；也沒有任何 Ingress / Gateway 資源。

**必要性**:前後端分離專案的主流入口模式是：

```
Internet → Ingress Controller (nginx/traefik)
             ├── /      → frontend-service:80
             └── /api   → backend-service:8080
```

好處：單一網域、統一 TLS 終止（搭配 cert-manager 自動簽 Let's Encrypt）、同源架構下 CORS 問題大幅簡化（見第 9 點）。

**建議做法**：新增 `ingress.yaml`，以路徑分流 `/` 與 `/api`，並規劃 TLS。若目前僅在本機測試，也應把「port-forward / NodePort 僅限本機」的前提寫進 README。

### 6. initContainer 以 `nc` 輪詢等待依賴——反模式

**現況**：frontend 等 backend、backend 等 SQL Server 與 Redis，都用 busybox `nc -z` 無限輪詢；還為此維護了一個自製 busybox 鏡像。

**必要性**：
- 這是 Docker Compose 思維的殘留。K8s 的原生機制已涵蓋此需求：backend 的 **readinessProbe 失敗時不會接流量**，Spring Boot 連不上 DB 會啟動失敗並由 kubelet 以退避重啟——最終一致，不需要人為排序。
- initContainer 無限等待反而**拖慢並模糊部署失敗訊號**：依賴服務壞掉時，看到的是 frontend 卡在 `Init:0/1`，而不是真正故障的元件。
- 順帶可刪掉 `busybox.Dockerfile` 這個只為了 init 等待而存在的自製鏡像，減少維護面。

**建議做法**：移除三個 initContainers，讓 readiness probe＋重啟策略處理啟動順序。若 Spring Boot 啟動時 DB 未就緒會直接 crash，屬正常現象（CrashLoopBackOff 幾次後成功），介意的話可在應用層設定連線重試。

### 7. 單一副本、無 PodDisruptionBudget

**現況**：所有 Deployment `replicas: 1`。

**必要性**：無狀態的 frontend / backend 只要一個 Pod 重啟（更新、節點維護、驅逐）服務就中斷。企業級最低標準是無狀態服務 **replicas ≥ 2** 並搭配 `PodDisruptionBudget`，成本極低（前端 nginx 幾乎不吃資源）。

**建議做法**：frontend / backend 調成 2 副本＋PDB（`minAvailable: 1`）。SQL Server / Redis 單副本可接受（多副本需要另外的複寫架構），但要確保 `Recreate` 策略與備份機制。流量有波動再考慮 HPA。

### 8. hostPath PersistentVolume 不可攜、且兩個 PVC 行為不一致 ✅

**現況**：`sqlserver.yaml` 手刻了一個 `hostPath` PV（`/mnt/data/sqlserver`）＋指定 `storageClassName: standard` 的 PVC；`redis-pvc` 則沒指定 storageClass、也沒有對應 PV。

**必要性**：
- `hostPath` 把資料綁死在特定節點，Pod 換節點資料就「消失」，多節點叢集不可用；這只適合單節點本機環境。
- 手刻 PV 指定 `storageClassName: standard` 的寫法在不同環境會撞名（Minikube 的 standard 是 dynamic provisioner，會直接動態配一顆新的而不是綁你手刻的 PV），行為不可預期。
- 兩個 PVC 一個指定 class、一個不指定，換環境時行為會分歧。

**建議做法**：刪除手刻 PV，兩個 PVC 統一「只寫 PVC、交給 StorageClass 動態供應」；本機 Minikube 與各雲端環境都支援 dynamic provisioning，這是可攜性最好的寫法。

---

## 🟡 低優先：品質與細節

### 9. CORS 白名單放在 Secret，且值是 localhost

**現況**：`CORS_ALLOWED_ORIGINS` 從 `backend-secret` 讀，解碼後是 `http://localhost:5173,http://127.0.0.1:5173,...`。

**問題**：CORS 白名單不是機密，放 Secret 混淆了「機密」與「設定」的界線，主流做法是放 **ConfigMap**。另外在叢集內部署時，瀏覽器實際的 Origin 會是 Ingress 網域而非 localhost:5173——目前的值只在本機開發時有效。若採第 5 點的同源 Ingress 架構（前後端同網域），CORS 幾乎可以整個移除。

### 10. 無效／錯位的環境變數

- `frontend.yaml` 的 `NPM_RC_FILE: settings-nexus.xml` 與 `backend.yaml` 的 `MVN_SETTINGS: settings-nexus.xml`：npm/maven 設定是**建置期**（Dockerfile 內）的事，runtime 容器裡沒有任何程序會讀它們，應刪除。且 `settings-nexus.xml` 是 Maven 格式，跟 `NPM_RC_FILE` 名稱自相矛盾。
- `frontend.yaml` 的 `DNS_RESOLVER: kube-dns.kube-system.svc.cluster.local`：nginx 的 `resolver` 指令需要 **IP** 而不是 hostname（nginx 無法用 DNS 名稱去找 DNS server，雞生蛋問題）。若前端 nginx 有做 `proxy_pass` 到 backend，正確做法是直接寫 `resolver kube-dns.kube-system.svc.cluster.local` 無效、應使用 `10.96.0.10`（叢集 DNS ClusterIP）或乾脆不用變數化的 proxy_pass（靜態 upstream 不需要 resolver）。建議實際驗證這個變數是否真的有被 nginx 模板使用。
- `SPRING_PROFILES_ACTIVE: "docker"`：跑在 K8s 卻叫 docker profile，語意混淆，建議建立 `k8s` 或 `prod` profile。

### 11. 命名、組織與中繼資料

- `redis.yaml:15` 的 Deployment 名稱是 **`redis-deploymentment`**——錯字（多了 `ment`），應更正為 `redis-deployment`（更主流的命名其實是直接叫 `redis`，`-deployment` 後綴屬冗餘）。
- **缺 namespace**：所有資源都落在 `default`（只有 redis-secret 顯式寫了 `default`）。企業實踐是至少建立一個專案 namespace（如 `lookgo`），做資源隔離、RBAC 與 quota 的邊界。
- **缺標準 labels**：只有 `app` 一個 label。建議補上 Kubernetes 推薦標籤（`app.kubernetes.io/name`、`app.kubernetes.io/component`、`app.kubernetes.io/part-of: lookgo` 等），監控、成本歸戶、`kubectl` 篩選都靠它。
- **缺環境分層**：目前是一份寫死的 YAML。中小型專案主流是 **Kustomize**（base + overlays/dev/prod），不用引入額外工具鏈（`kubectl -k` 內建）；需求變複雜再上 Helm。

### 12. 安全性 hardening（securityContext）

**現況**：只有 sqlserver 設了 `fsGroup: 10001`，其餘容器全部以預設（多半是 root）身分運行。

**建議**：為 frontend / backend / redis 補上基本 securityContext，這是企業叢集（尤其有 Pod Security Standards `restricted` 政策時）的入場券：

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
```

> 注意：nginx 官方鏡像預設綁 80 port 需 root，主流解法是改用 `nginxinc/nginx-unprivileged`（監聽 8080）。

### 13. Probe 細節

- **backend 應使用 Spring Boot 專用探針端點**：`/actuator/health` 會聚合所有 health indicator（含 DB、Redis）——DB 短暫抖動會讓 liveness 失敗而**重啟一個其實健康的 backend**，重啟也修不好 DB。主流做法：liveness 用 `/actuator/health/liveness`、readiness 用 `/actuator/health/readiness`（需在 application 設定開啟 `management.endpoint.health.probes.enabled=true`）。
- **建議補 `startupProbe`**：Spring Boot 冷啟動常超過 15 秒，與其拉長 `initialDelaySeconds`，用 startupProbe（如 `failureThreshold: 30, periodSeconds: 2`）能同時容忍慢啟動又保持快速偵測。
- **SQL Server 的 liveness/readiness 完全相同**且 `initialDelaySeconds: 60` 偏暴力，同樣建議用 startupProbe 取代長 delay。
- redis 的 `redis-cli ping` 有 `REDISCLI_AUTH` 支撐，可用；但注意 `--raw ping` 在密碼錯誤時仍回非零值，行為正確，維持即可。

### 14. SQL Server 初始化方式

**現況**：自製鏡像 + 自寫 `init-db.sh`（手動背景啟動 sqlservr、輪詢、跑 init.sql、`wait`），並覆蓋容器 `command`。

**問題**：自己接管資料庫進程的生命週期容易踩訊號處理（graceful shutdown）與升級相容性的坑；`set -e` 加上背景進程的組合在 init 失敗時行為也不直觀。**每次 Pod 重啟都會重跑 init.sql**，必須確保腳本冪等。

**建議**：初始化改為一次性的 **Kubernetes Job**（用官方 mssql 鏡像 + sqlcmd 對 service 執行 init.sql），資料庫容器保持官方 entrypoint 不動。這也讓 `sqlserver.Dockerfile` 可以整個刪除、直接用官方鏡像。

---

## 建議的調整順序

1. **立即**：輪換所有已提交的憑證（TDX、JWT、DB、Redis、admin）；把 secret YAML 移出版控（第 1 點）。
2. **本週**:加 resources、改鏡像 tag 策略、有狀態服務加 `Recreate`／改 StatefulSet（第 2、3、4 點）。
3. **下一步**：加 Ingress + namespace + Kustomize 環境分層，移除 initContainers 與無效環境變數（第 5、6、10、11 點）。
4. **持續改進**：securityContext、探針精細化、init Job 化、無狀態服務雙副本（第 7、12、13、14 點）。
