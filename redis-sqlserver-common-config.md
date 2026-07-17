# Redis 與 SQL Server 共用配置寫法

> 比對對象：`k8s/redis.yaml` 與 `k8s/sqlserver.yaml`。
> 範圍：兩者都是「有狀態服務」（需要 PVC 保存資料），因此 PVC / Deployment / Service 的骨架寫法相同，只有名稱與數值不同。
> 每組左邊是 redis.yaml 的寫法、右邊是 sqlserver.yaml 的對應寫法，並列以方便比較。

## 1. PVC 共用骨架

```yaml
# --- redis.yaml 的 PVC ---
apiVersion: v1                     # 核心 API 群組版本，PVC 這個資源類型屬於 v1
kind: PersistentVolumeClaim        # 宣告資源類型為「持久化儲存宣告」，向叢集申請一塊可掛載的儲存空間
metadata:
  name: redis-pvc                  # 這個 PVC 的名稱，之後在 Deployment 的 volumes 區塊會用這個名稱引用
spec:
  accessModes:
    - ReadWriteOnce                 # 限制同一時間只能被一個節點掛載讀寫，符合單一 Pod 資料庫的使用情境
  resources:
    requests:
      storage: 1Gi                  # 跟叢集申請至少 1Gi 的儲存容量

---
# --- sqlserver.yaml 的 PVC（同樣結構，只有名稱與容量不同）---
apiVersion: v1                     # 與 redis 相同，PVC 屬於核心 API 群組 v1
kind: PersistentVolumeClaim        # 與 redis 相同，宣告為持久化儲存宣告
metadata:
  name: sqlserver-pvc               # sqlserver 專屬的 PVC 名稱
spec:
  accessModes:
    - ReadWriteOnce                 # 與 redis 相同的存取模式，單一節點讀寫
  resources:
    requests:
      storage: 2Gi                  # 與 redis 相同的欄位，只是容量需求較大（SQL Server 官方建議至少 2Gi）
```

## 2. Deployment 共用骨架

```yaml
# --- redis.yaml 的 Deployment 開頭 ---
apiVersion: apps/v1                 # Deployment 屬於 apps/v1 這個 API 群組（非核心 v1）
kind: Deployment                    # 宣告資源類型為 Deployment，負責管理 Pod 的建立與滾動更新
metadata:
  name: redis-deploymentment        # Deployment 名稱（注意：現有拼字多了 ment，屬既有筆誤）
spec:
  replicas: 1                       # 期望維持 1 個 Pod 副本
  selector:
    matchLabels:
      app: redis                    # Deployment 用這個 label 找到自己管理的 Pod
  template:
    metadata:
      labels:
        app: redis                  # Pod 實際被打上的 label，需與上面 selector 一致，否則 Deployment 抓不到自己的 Pod
    spec:
      containers:
        - name: redis                # 容器名稱，同一 Pod 內可用來區分多個容器
          image: docker.io/library/lookgo-redis:latest   # 使用的映像檔位置與 tag
          imagePullPolicy: IfNotPresent                  # 本機已有同名映像檔就不重新拉取，沒有才去 pull

---
# --- sqlserver.yaml 的 Deployment 開頭（同樣結構）---
apiVersion: apps/v1                 # 與 redis 相同，同屬 apps/v1
kind: Deployment                    # 與 redis 相同，宣告為 Deployment
metadata:
  name: sqlserver-deployment        # sqlserver 專屬名稱（這裡沒有筆誤）
spec:
  replicas: 1                       # 與 redis 相同，只維持 1 個副本
  selector:
    matchLabels:
      app: sqlserver                 # 與 redis 相同的寫法，用 label 綁定要管理的 Pod
  template:
    metadata:
      labels:
        app: sqlserver               # 與 redis 相同，Pod 的 label 需對應上面 selector
    spec:
      containers:
        - name: sqlserver             # 與 redis 相同欄位，容器名稱
          image: docker.io/library/lookgo-sqlserver:latest  # 對應 sqlserver 專屬映像檔
          imagePullPolicy: IfNotPresent                     # 與 redis 相同的拉取策略
```

## 3. 探針（Probe）共用骨架

redis 與 sqlserver 都是用 `exec`（在容器內執行指令判斷存活/就緒），而不是像 backend/frontend 用 HTTP 端點：

```yaml
# --- redis.yaml 的 probe ---
livenessProbe:
  exec:
    command: ["redis-cli", "--raw", "ping"]  # 進容器內執行 redis-cli ping，回傳 PONG 才算存活
  initialDelaySeconds: 5    # 容器啟動後等 5 秒才開始檢查，給程式一點啟動時間
  periodSeconds: 5          # 之後每 5 秒檢查一次
  timeoutSeconds: 3         # 單次檢查超過 3 秒沒回應就算失敗
  failureThreshold: 3       # 連續失敗 3 次才判定為真正異常（避免單次抖動就誤判）

---
# --- sqlserver.yaml 的 probe（同樣的四個欄位骨架）---
livenessProbe:
  exec:
    command: ["/bin/bash", "-c", "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P \"$MSSQL_SA_PASSWORD\" -C -Q \"SELECT 1\""]  # 進容器內對本機資料庫下 SELECT 1，能查詢成功才算存活
  initialDelaySeconds: 60   # 與 redis 相同欄位，只是 SQL Server 啟動慢，等待時間拉長為 60 秒
  periodSeconds: 5          # 與 redis 相同，每 5 秒檢查一次
  timeoutSeconds: 10        # 與 redis 相同欄位，SQL Server 查詢較慢，逾時秒數也拉長
  failureThreshold: 3       # 與 redis 相同，連續失敗 3 次才判定異常
```

## 4. Volume 掛載共用骨架

```yaml
# --- redis.yaml ---
volumeMounts:
  - name: redis-data              # 對應下面 volumes 區塊同名的掛載定義
    mountPath: /data               # 掛載到容器內 redis 預設的資料目錄
volumes:
  - name: redis-data               # 這個 volume 的識別名稱，需與 volumeMounts.name 一致
    persistentVolumeClaim:
      claimName: redis-pvc          # 指向前面定義的 PVC，實際儲存空間由它提供

---
# --- sqlserver.yaml（同樣結構）---
volumeMounts:
  - name: sqlserver-data           # 與 redis 相同寫法，對應下方 volumes 定義
    mountPath: /var/opt/mssql       # 掛載到 SQL Server 預設的資料目錄（與 redis 掛載路徑不同）
volumes:
  - name: sqlserver-data            # 與 redis 相同欄位結構
    persistentVolumeClaim:
      claimName: sqlserver-pvc       # 指向 sqlserver 專屬的 PVC
```

## 5. Service 共用骨架

```yaml
# --- redis.yaml 的 Service ---
apiVersion: v1               # Service 屬於核心 API 群組 v1
kind: Service                 # 宣告資源類型為 Service，提供穩定的叢集內部存取入口
metadata:
  name: redis-service          # Service 名稱，其他 Pod 可透過此名稱做 DNS 解析連線
spec:
  type: ClusterIP              # 只在叢集內部可見，不對外曝露
  selector:
    app: redis                  # 透過此 label 找到要轉發流量的目標 Pod
  ports:
    - port: 6379                 # Service 對外（叢集內）曝露的埠號
      targetPort: 6379            # 實際轉發到容器內的埠號

---
# --- sqlserver.yaml 的 Service（同樣結構）---
apiVersion: v1                # 與 redis 相同
kind: Service                  # 與 redis 相同
metadata:
  name: sqlserver-service       # sqlserver 專屬名稱
spec:
  type: ClusterIP               # 與 redis 相同，僅限叢集內部存取
  selector:
    app: sqlserver               # 與 redis 相同寫法，對應 Deployment 的 label
  ports:
    - port: 1433                  # sqlserver 對外曝露的埠號（SQL Server 預設埠）
      targetPort: 1433             # 轉發到容器內同樣的埠號
```
