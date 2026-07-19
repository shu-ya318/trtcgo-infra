# Backend 與 Frontend 分別配置寫法

> 比對對象：`k8s/backend.yaml` 與 `k8s/frontend.yaml`。
> 範圍：兩邊各自獨有、對方沒有對應寫法的部分，分兩段列出，互不對應。

## Backend 專屬配置（backend.yaml）

```yaml
spec:
  template:
    spec:
      initContainers:
        - name: wait-for-sqlserver          # backend 依賴資料庫，多這一個 initContainer（frontend 沒有）
          image: docker.io/library/lookgo-busybox:latest
          imagePullPolicy: IfNotPresent
          command:
            [
              "sh",
              "-c",
              "until nc -z sqlserver-service 1433; do echo waiting for sqlserver-service; sleep 2; done",
            ]
        - name: wait-for-redis               # backend 額外依賴 redis 快取，第二個 initContainer（frontend 只有一個依賴、只需一個）
          image: docker.io/library/lookgo-busybox:latest
          imagePullPolicy: IfNotPresent
          command:
            [
              "sh",
              "-c",
              "until nc -z redis-service 6379; do echo waiting for redis-service; sleep 2; done",
            ]
      containers:
        - name: backend
          image: docker.io/library/lookgo-backend:latest
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080              # backend 監聽 8080（Spring Boot 預設埠）
          env:
            - name: SPRING_PROFILES_ACTIVE     # 指定 Spring Boot 啟用哪個設定檔（application-docker.yml）
              value: "docker"
            - name: DB_HOST                    # 資料庫主機位址，指向 sqlserver-service 這個 k8s Service
              value: "sqlserver-service"
            - name: DB_PORT                     # 資料庫埠號
              value: "1433"
            - name: DB_NAME                     # 從 sqlserver-secret 讀取資料庫名稱
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-name
            - name: DB_USERNAME                  # 從 sqlserver-secret 讀取資料庫帳號
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-username
            - name: DB_PASSWORD                   # 從 sqlserver-secret 讀取資料庫密碼
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-password
            - name: REDIS_HOST                    # Redis 主機位址，指向 redis-service
              value: "redis-service"
            - name: REDIS_PASSWORD                 # 從 redis-secret 讀取 Redis 密碼
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: redis-password
            - name: JWT_SECRET                      # 從 jwt-secret 讀取簽章金鑰，用來簽發/驗證登入 token
              valueFrom:
                secretKeyRef:
                  name: jwt-secret
                  key: secret
            - name: JWT_ACCESS_TOKEN_EXPIRATION       # access token 有效時間（毫秒），直接寫死明文值；3600000 毫秒 = 1 小時
              value: "3600000"
            - name: JWT_REFRESH_TOKEN_EXPIRATION       # refresh token 有效時間（毫秒）
              value: "604800000"
            - name: ADMIN_PASSWORD                      # 從 backend-secret 讀取預設管理員密碼，optional: true 代表 key 不存在也不會讓 Pod 啟動失敗
              valueFrom:
                secretKeyRef:
                  name: backend-secret
                  key: admin-password
                  optional: true
            - name: CORS_ALLOWED_ORIGINS                 # 從 backend-secret 讀取允許跨來源請求的網域清單
              valueFrom:
                secretKeyRef:
                  name: backend-secret
                  key: cors-allowed-origins
                  optional: true
            - name: RAIL_PROXY_HOST                       # 第三方鐵路 API 代理主機（optional，未設定不影響啟動）
              valueFrom:
                secretKeyRef:
                  name: backend-secret
                  key: rail-proxy-host
                  optional: true
            - name: RAIL_PROXY_PORT                        # 第三方鐵路 API 代理埠號
              valueFrom:
                secretKeyRef:
                  name: backend-secret
                  key: rail-proxy-port
                  optional: true
            - name: TDX_CLIENT_ID                           # TDX 運輸資料平台的用戶端 ID（非 optional，缺少會啟動失敗）
              valueFrom:
                secretKeyRef:
                  name: backend-secret
                  key: tdx-client-id
            - name: TDX_CLIENT_SECRET                        # TDX 用戶端密鑰
              valueFrom:
                secretKeyRef:
                  name: backend-secret
                  key: tdx-client-secret
            - name: MVN_SETTINGS                              # 建置期用的 Maven 設定檔名稱，明文寫死（runtime 容器內其實用不到）
              value: "settings-nexus.xml"
          livenessProbe:
            httpGet:
              path: /actuator/health                          # Spring Boot Actuator 健康檢查端點，會聚合 DB/Redis 連線狀態
              port: 8080
```

## Frontend 專屬配置（frontend.yaml）

```yaml
spec:
  template:
    spec:
      initContainers:
        - name: wait-for-backend           # frontend 只依賴 backend 一項服務，只需一個 initContainer
          image: docker.io/library/lookgo-busybox:latest
          imagePullPolicy: IfNotPresent
          command:
            [
              "sh",
              "-c",
              "until nc -z backend-service 8080; do echo waiting for backend-service; sleep 2; done",
            ]
      containers:
        - name: frontend
          image: docker.io/library/lookgo-frontend:latest
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80                # frontend 監聽 80（nginx 預設埠）
          env:
            - name: DNS_RESOLVER                # nginx 用來解析內部 hostname 的 DNS 位址，明文寫死（backend 沒有這類 nginx 專屬變數）
              value: "kube-dns.kube-system.svc.cluster.local"  # 確保 hostname 可以被正確解析、拿到 CoreDNS 位址
            - name: BACKEND_URL                  # nginx 反向代理要轉發到的 backend 完整位址
              value: "backend-service.default.svc.cluster.local:8080"  # 用完整 FQDN，不能用短名稱
            - name: NPM_RC_FILE                   # 建置期用的 npm 設定檔名稱，明文寫死（runtime 容器內其實用不到）
              value: "settings-nexus.xml"
          livenessProbe:
            httpGet:
              path: /                              # frontend 沒有 actuator，直接檢查首頁能否回應
              port: 80
```
