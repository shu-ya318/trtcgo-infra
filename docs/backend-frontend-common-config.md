# Backend 與 Frontend 共用配置寫法

> 比對對象：`k8s/backend.yaml` 與 `k8s/frontend.yaml`。
> 範圍：兩者都是無狀態服務（沒有 PVC），Deployment/Service 骨架、initContainer 等待模式、httpGet 探針寫法都相同，只差名稱、埠號與細節內容。

## 1. Deployment 開頭骨架

```yaml
# --- backend.yaml ---
apiVersion: apps/v1              # 與 frontend 相同，Deployment 屬於 apps/v1
kind: Deployment                  # 與 frontend 相同
metadata:
  name: backend-deployment         # backend 專屬名稱
spec:
  replicas: 1                      # 與 frontend 相同，只維持 1 個副本
  selector:
    matchLabels:
      app: backend                  # 與 frontend 相同寫法，用 label 綁定 Pod
  template:
    metadata:
      labels:
        app: backend                 # 與 frontend 相同，需對應上面 selector

---
# --- frontend.yaml（同樣結構）---
apiVersion: apps/v1              # 與 backend 相同
kind: Deployment                  # 與 backend 相同
metadata:
  name: frontend-deployment        # frontend 專屬名稱
spec:
  replicas: 1                      # 與 backend 相同
  selector:
    matchLabels:
      app: frontend                 # 與 backend 相同寫法
  template:
    metadata:
      labels:
        app: frontend                 # 與 backend 相同，需對應上面 selector
```

## 2. initContainer「等待依賴服務」共用模式

兩邊都用 busybox 映像跑 `nc -z` 迴圈等待依賴服務的 port 開啟，寫法完全相同，只是等的對象不同：

```yaml
# --- backend.yaml 其中一個 initContainer（等 sqlserver）---
initContainers:
  - name: wait-for-sqlserver          # initContainer 名稱，會在主容器啟動前依序執行完畢
    image: docker.io/library/lookgo-busybox:latest   # 用輕量 busybox 映像跑等待腳本，不需要完整 backend 映像
    imagePullPolicy: IfNotPresent
    command:
      [
        "sh",
        "-c",
        "until nc -z sqlserver-service 1433; do echo waiting for sqlserver-service; sleep 2; done",  # 不斷嘗試連線 sqlserver-service:1433，連上才跳出迴圈，讓下面主容器開始啟動
      ]

---
# --- frontend.yaml 的 initContainer（等 backend，同樣模式）---
initContainers:
  - name: wait-for-backend             # 與 backend 端寫法相同，只是等待對象換成 backend-service
    image: docker.io/library/lookgo-busybox:latest    # 與 backend 端相同，共用同一顆自製 busybox 映像
    imagePullPolicy: IfNotPresent
    command:
      [
        "sh",
        "-c",
        "until nc -z backend-service 8080; do echo waiting for backend-service; sleep 2; done",  # 與 backend 端相同寫法，改成輪詢 backend-service:8080
      ]
```

## 3. 主容器與探針共用骨架

backend、frontend 都用 `httpGet` 探針（不像 redis/sqlserver 用 `exec`），欄位結構相同：

```yaml
# --- backend.yaml ---
containers:
  - name: backend                       # 容器名稱
    image: docker.io/library/lookgo-backend:latest   # 使用的映像檔
    imagePullPolicy: IfNotPresent         # 與 frontend 相同的拉取策略
    ports:
      - containerPort: 8080               # 容器對外監聽的埠號
livenessProbe:
  httpGet:
    path: /actuator/health                # 用 HTTP 請求打這個路徑判斷存活
    port: 8080                             # 對應上面 containerPort
  initialDelaySeconds: 15                  # 啟動後等 15 秒才開始檢查
  periodSeconds: 10                        # 每 10 秒檢查一次
  timeoutSeconds: 10                       # 逾時 10 秒算失敗
  failureThreshold: 5                      # 連續失敗 5 次才判定異常

---
# --- frontend.yaml（同樣結構，只換路徑與埠號）---
containers:
  - name: frontend                       # 與 backend 相同欄位結構
    image: docker.io/library/lookgo-frontend:latest    # frontend 專屬映像
    imagePullPolicy: IfNotPresent           # 與 backend 相同
    ports:
      - containerPort: 80                   # frontend 監聽的埠號（nginx 預設 80）
livenessProbe:
  httpGet:
    path: /                                 # 與 backend 相同寫法，只是換成首頁路徑
    port: 80                                 # 對應上面 containerPort
  initialDelaySeconds: 5                     # 與 backend 相同欄位，只是 nginx 啟動快，秒數設短一點
  periodSeconds: 5                           # 與 backend 相同欄位結構
  timeoutSeconds: 5                          # 與 backend 相同欄位結構
  failureThreshold: 3                        # 與 backend 相同欄位結構
```

## 4. Service 共用骨架

```yaml
# --- backend.yaml 的 Service ---
apiVersion: v1                # 與 frontend 相同
kind: Service                  # 與 frontend 相同
metadata:
  name: backend-service         # backend 專屬名稱
spec:
  type: ClusterIP               # 與 frontend 相同，僅限叢集內部存取
  selector:
    app: backend                 # 對應 Deployment 的 label
  ports:
    - port: 8080                  # 曝露埠號
      targetPort: 8080              # 轉發到容器內埠號

---
# --- frontend.yaml 的 Service（同樣結構）---
apiVersion: v1                # 與 backend 相同
kind: Service                  # 與 backend 相同
metadata:
  name: frontend-service         # frontend 專屬名稱
spec:
  type: ClusterIP                # 與 backend 相同
  selector:
    app: frontend                 # 對應 Deployment 的 label
  ports:
    - port: 80                      # 曝露埠號（與容器埠號一致）
      targetPort: 80                  # 轉發到容器內埠號
```
