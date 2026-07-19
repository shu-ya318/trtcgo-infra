# Redis 與 SQL Server 共用配置寫法

> 比對對象:`k8s/redis.yaml` 與 `k8s/sqlserver.yaml`。
> 範圍:兩者的 Deployment / Service 骨架、覆寫啟動指令、`exec` 探針寫法都相同,只有名稱與數值不同。
> 注意:redis 已改為「純快取、無持久化」——目前**只有 sqlserver 有 PVC**,儲存相關寫法移至《redis-sqlserver-specific-config.md》的 SQL Server 專屬段落。

## 1. Deployment 共用骨架

```yaml
# --- redis.yaml 的 Deployment 開頭 ---
apiVersion: apps/v1                 # Deployment 屬於 apps/v1 這個 API 群組(非核心 v1)
kind: Deployment                    # 宣告資源類型為 Deployment,負責管理 Pod 的建立與滾動更新
metadata:
  name: redis-deployment            # Deployment 名稱(舊版錯字 redis-deploymentment 已修正)
spec:
  replicas: 1                       # 期望維持 1 個 Pod 副本
  selector:
    matchLabels:
      app: redis                    # Deployment 用這個 label 找到自己管理的 Pod
  template:
    metadata:
      labels:
        app: redis                  # Pod 實際被打上的 label,需與上面 selector 一致,否則 Deployment 抓不到自己的 Pod
    spec:
      containers:
        - name: redis                # 容器名稱,同一 Pod 內可用來區分多個容器
          image: docker.io/library/lookgo-redis:latest   # 使用的映像檔位置與 tag
          imagePullPolicy: IfNotPresent                  # 本機已有同名映像檔就不重新拉取,沒有才去 pull

---
# --- sqlserver.yaml 的 Deployment 開頭(同樣結構)---
apiVersion: apps/v1                 # 與 redis 相同,同屬 apps/v1
kind: Deployment                    # 與 redis 相同,宣告為 Deployment
metadata:
  name: sqlserver-deployment        # sqlserver 專屬名稱
spec:
  replicas: 1                       # 與 redis 相同,只維持 1 個副本
  selector:
    matchLabels:
      app: sqlserver                 # 與 redis 相同的寫法,用 label 綁定要管理的 Pod
  template:
    metadata:
      labels:
        app: sqlserver               # 與 redis 相同,Pod 的 label 需對應上面 selector
    spec:
      containers:
        - name: sqlserver             # 與 redis 相同欄位,容器名稱
          image: docker.io/library/lookgo-sqlserver:latest  # 對應 sqlserver 專屬映像檔
          imagePullPolicy: IfNotPresent                     # 與 redis 相同的拉取策略
```

## 2. 覆寫容器啟動指令(command)共用模式

兩邊都覆寫了映像檔預設的啟動指令,只是目的不同:

```yaml
# --- redis.yaml ---
command: ['redis-server', '--requirepass', '$(REDIS_PASSWORD)']  # 強制 redis-server 啟動時要求密碼;$(VAR) 是 k8s 的環境變數替換語法,值來自下方 env 的 Secret 引用

---
# --- sqlserver.yaml(同樣是覆寫 command,改跑自製初始化腳本)---
command: ['/bin/bash', '/opt/mssql-tools18/bin/init-db.sh']       # 改執行自製腳本:背景啟動 sqlservr、等待就緒、跑 init.sql 建庫建帳號
```

## 3. 探針(Probe)共用骨架

redis 與 sqlserver 都是用 `exec`(在容器內執行指令判斷存活/就緒),而不是像 backend/frontend 用 HTTP 端點;且兩邊的 livenessProbe 與 readinessProbe 內容完全相同,只差數值:

```yaml
# --- redis.yaml 的 probe(liveness 與 readiness 寫法相同)---
livenessProbe:
  exec:
    command: ['redis-cli', '--raw', 'ping']  # 進容器內執行 redis-cli ping,回傳 PONG 才算存活(密碼由 REDISCLI_AUTH 環境變數自動帶入)
  initialDelaySeconds: 5    # 容器啟動後等 5 秒才開始檢查,給程式一點啟動時間
  periodSeconds: 5          # 之後每 5 秒檢查一次
  timeoutSeconds: 3         # 單次檢查超過 3 秒沒回應就算失敗
  failureThreshold: 3       # 連續失敗 3 次才判定為真正異常(避免單次抖動就誤判)

---
# --- sqlserver.yaml 的 probe(同樣的欄位骨架,數值配合啟動較慢而拉長)---
livenessProbe:
  exec:
    command:
      - /bin/bash
      - -c
      - /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -Q "SELECT 1"  # 對本機資料庫下 SELECT 1,能查詢成功才算存活
  initialDelaySeconds: 60   # 與 redis 相同欄位,只是 SQL Server 啟動慢,等待時間拉長為 60 秒
  periodSeconds: 5          # 與 redis 相同,每 5 秒檢查一次
  timeoutSeconds: 10        # 與 redis 相同欄位,SQL Server 查詢較慢,逾時秒數也拉長
  failureThreshold: 3       # 與 redis 相同,連續失敗 3 次才判定異常
```

## 4. Service 共用骨架

```yaml
# --- redis.yaml 的 Service ---
apiVersion: v1               # Service 屬於核心 API 群組 v1
kind: Service                 # 宣告資源類型為 Service,提供穩定的叢集內部存取入口
metadata:
  name: redis-service          # Service 名稱,其他 Pod 可透過此名稱做 DNS 解析連線
spec:
  type: ClusterIP              # 只在叢集內部可見,不對外曝露
  selector:
    app: redis                  # 透過此 label 找到要轉發流量的目標 Pod
  ports:
    - port: 6379                 # Service 對外(叢集內)曝露的埠號
      targetPort: 6379            # 實際轉發到容器內的埠號

---
# --- sqlserver.yaml 的 Service(同樣結構)---
apiVersion: v1                # 與 redis 相同
kind: Service                  # 與 redis 相同
metadata:
  name: sqlserver-service       # sqlserver 專屬名稱
spec:
  type: ClusterIP               # 與 redis 相同,僅限叢集內部存取
  selector:
    app: sqlserver               # 與 redis 相同寫法,對應 Deployment 的 label
  ports:
    - port: 1433                  # sqlserver 對外曝露的埠號(SQL Server 預設埠)
      targetPort: 1433             # 轉發到容器內同樣的埠號
```
